import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { extractJsonObject } from './lib/parse';

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MODEL_ID = process.env.MODEL_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;

const SYSTEM_PROMPT = `You are an analyst summarizing customer reviews for an e-commerce
electronics catalog. Given a list of reviews, summarize overall sentiment and surface
recurring themes (issues or praise that show up across multiple reviews).
Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly:
  "overallSentiment": string, a short verdict like "mostly positive" or "mixed",
  "summary": string, 2-3 sentences capturing the big picture,
  "themes": array of 3-6 objects, each { "theme": string, "sentiment": "positive"|"negative"|"mixed", "detail": string }.`;

interface Digest {
  overallSentiment: string;
  summary: string;
  themes: { theme: string; sentiment: string; detail: string }[];
}

export function parseDigest(raw: string): Digest {
  const obj = extractJsonObject(raw);
  if (typeof obj.overallSentiment !== 'string' || typeof obj.summary !== 'string' || !Array.isArray(obj.themes)) {
    throw new Error('missing required fields');
  }
  return obj as unknown as Digest;
}

interface Row { productId: string; sk: string; [k: string]: unknown }

// Read the whole (small) table, paginating through Scan.
async function scanAll(): Promise<Row[]> {
  const rows: Row[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey }));
    rows.push(...((res.Items ?? []) as Row[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

export const handler = async () => {
  const rows = await scanAll();
  const titles = new Map<string, string>();
  rows.filter((r) => r.sk === 'PRODUCT').forEach((p) => titles.set(p.productId, String(p.title ?? p.productId)));
  const reviews = rows.filter((r) => r.sk.startsWith('REVIEW#'));

  if (reviews.length === 0) {
    console.log('no reviews to summarize');
    return { ok: false, message: 'no reviews found' };
  }

  const ratings = reviews.map((r) => Number(r.rating)).filter((n) => !Number.isNaN(n));
  const averageRating =
    ratings.length > 0 ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null;

  const reviewLines = reviews
    .map((r) => `[${titles.get(r.productId) ?? r.productId}] (${r.rating}/5) ${r.text}`)
    .join('\n');

  // call Bedrock
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: `Reviews:\n${reviewLines}` }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.4 },
    }),
  );
  const raw = res.output?.message?.content?.[0]?.text;
  if (!raw) throw new Error('empty model response');
  const tokens = {
    input: res.usage?.inputTokens ?? null,
    output: res.usage?.outputTokens ?? null,
    total: res.usage?.totalTokens ?? null,
  };

  let digest: Digest;
  try {
    digest = parseDigest(raw);
  } catch (err) {
    console.error('could not parse model output:', err, '\nraw:', raw);
    throw new Error('model did not return valid JSON');
  }

  // persist the digest
  const generatedAt = new Date().toISOString();
  const item = {
    productId: 'DIGEST',
    sk: generatedAt,
    generatedAt,
    reviewCount: reviews.length,
    averageRating,
    tokens,
    ...digest,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  console.log(
    `digest written: ${reviews.length} reviews, sentiment "${digest.overallSentiment}", ` +
      `tokens in/out/total: ${tokens.input}/${tokens.output}/${tokens.total}`,
  );
  return item;
};
