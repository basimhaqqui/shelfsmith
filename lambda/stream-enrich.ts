import { randomUUID } from 'crypto';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { extractJsonObject } from './lib/parse';
import { buildUserContent } from './lib/enrichment';

// `awslambda` is a global provided by the Lambda streaming runtime (no import exists).
declare const awslambda: {
  streamifyResponse: (h: (event: any, responseStream: any, context: any) => Promise<void>) => any;
  HttpResponseStream: { from(stream: any, metadata: any): any };
};

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MODEL_ID = process.env.MODEL_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;

const SEP = '<<<STRUCTURED>>>';
const META = '<<<META>>>';

const SYSTEM_PROMPT = `You are a product-content writer for an e-commerce consumer-electronics catalog.
Given a raw product, produce catalog content in TWO parts, in this exact order:
1) The marketing description: 2-3 sentences of plain prose. No labels, no quotes, no JSON.
2) On its own line, the exact marker ${SEP}
3) A single JSON object (no markdown fences) with keys:
   "category" (string), "features" (array of 3-5 short strings), "keywords" (array of 5-8 lowercase strings).`;

export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: any): Promise<void> => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

    try {
      const rawBody = event.body
        ? event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body
        : '{}';
      const input = JSON.parse(rawBody);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) {
        stream.write('ERROR: a non-empty "title" is required');
        stream.end();
        return;
      }
      const specs = input.specs ?? null;

      const res = await bedrock.send(
        new ConverseStreamCommand({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: 'user', content: buildUserContent(title, specs) }],
          inferenceConfig: { maxTokens: 1024, temperature: 0.5 },
        }),
      );

      let full = '';
      let usage: any;
      for await (const ev of res.stream ?? []) {
        const delta = ev.contentBlockDelta?.delta?.text;
        if (delta) {
          full += delta;
          stream.write(delta); // live tokens to the browser
        }
        if (ev.metadata?.usage) usage = ev.metadata.usage;
      }

      // split the model output: prose description, then the structured JSON
      const sepIdx = full.indexOf(SEP);
      const description = (sepIdx >= 0 ? full.slice(0, sepIdx) : full).replace(/\{[\s\S]*$/, '').trim();
      let category = '';
      let features: string[] = [];
      let keywords: string[] = [];
      try {
        const obj = extractJsonObject(sepIdx >= 0 ? full.slice(sepIdx + SEP.length) : full);
        category = typeof obj.category === 'string' ? obj.category : '';
        features = Array.isArray(obj.features) ? obj.features.map(String) : [];
        keywords = Array.isArray(obj.keywords) ? obj.keywords.map(String) : [];
      } catch (err) {
        console.error('could not parse structured section', err);
      }

      const productId = randomUUID();
      const createdAt = new Date().toISOString();
      const tokens = {
        input: usage?.inputTokens ?? null,
        output: usage?.outputTokens ?? null,
        total: usage?.totalTokens ?? null,
      };
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { productId, sk: 'PRODUCT', title, specs, description, category, features, keywords, createdAt, tokens },
        }),
      );

      // final control line the browser parses for the structured fields
      stream.write('\n' + META + JSON.stringify({ productId, category, features, keywords, createdAt, tokens }));
      console.log(`streamed "${title}" — tokens total: ${tokens.total}`);
    } catch (err) {
      console.error('stream-enrich failed', err);
      stream.write('\n' + META + JSON.stringify({ error: 'generation failed' }));
    } finally {
      stream.end();
    }
  },
);
