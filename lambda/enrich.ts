import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const bedrock = new BedrockRuntimeClient({}); // region from the Lambda runtime
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MODEL_ID = process.env.MODEL_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;

const SYSTEM_PROMPT = `You are a product-content writer for an e-commerce consumer-electronics catalog
(audio gear, appliances, vehicle accessories). Given a raw product, write polished catalog content.
Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
  "description": string, a 2-3 sentence marketing description,
  "category": string, a concise product category,
  "features": array of 3-5 short bullet-point feature strings,
  "keywords": array of 5-8 lowercase SEO keyword strings.`;

interface Enriched {
  description: string;
  category: string;
  features: string[];
  keywords: string[];
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Models can wrap JSON in prose or ```fences```, so pull out the object defensively
// instead of trusting the response to be clean JSON.
function parseEnriched(raw: string): Enriched {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found');
    text = text.slice(start, end + 1);
  }

  const obj = JSON.parse(text);
  if (
    typeof obj.description !== 'string' ||
    typeof obj.category !== 'string' ||
    !Array.isArray(obj.features) ||
    !Array.isArray(obj.keywords)
  ) {
    throw new Error('missing required fields');
  }
  return {
    description: obj.description,
    category: obj.category,
    features: obj.features.map(String),
    keywords: obj.keywords.map(String),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // validate the request
  let input: { title?: string; specs?: unknown };
  try {
    input = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'request body must be valid JSON' });
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return json(400, { error: 'a non-empty "title" is required' });
  const specs = input.specs ?? null;

  const userPrompt =
    `Title: ${title}\n` +
    `Specs: ${typeof specs === 'string' ? specs : JSON.stringify(specs)}`;

  // call Bedrock
  let raw: string | undefined;
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: userPrompt }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0.5 },
      }),
    );
    raw = res.output?.message?.content?.[0]?.text;
  } catch (err) {
    console.error('bedrock invocation failed', err);
    return json(502, { error: 'model invocation failed' });
  }
  if (!raw) return json(502, { error: 'empty model response' });

  // parse the model output safely
  let enriched: Enriched;
  try {
    enriched = parseEnriched(raw);
  } catch (err) {
    console.error('could not parse model output:', err, '\nraw:', raw);
    return json(502, { error: 'model did not return valid JSON' });
  }

  // persist to DynamoDB
  const productId = randomUUID();
  const createdAt = new Date().toISOString();
  const item = { productId, sk: 'PRODUCT', title, specs, ...enriched, createdAt };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error('dynamodb put failed', err);
    return json(502, { error: 'failed to persist product' });
  }

  return json(201, { productId, title, ...enriched, createdAt });
};
