import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { extractJsonObject } from './lib/parse';

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MODEL_ID = process.env.MODEL_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;

const SYSTEM_PROMPT = `You are an analyst summarizing customer reviews for a single product
in an e-commerce electronics catalog. Given that product's reviews, summarize overall
sentiment and surface recurring themes (issues or praise that show up across multiple reviews).
Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly:
  "overallSentiment": string, a short verdict like "mostly positive" or "mixed",
  "summary": string, 2-3 sentences capturing the big picture for this product,
  "themes": array of 2-5 objects, each { "theme": string, "sentiment": "positive"|"negative"|"mixed", "detail": string }.`;

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

// Summarize one product's reviews.
async function summarize(title: string, reviews: Row[]) {
  const reviewLines = reviews.map((r) => `(${r.rating}/5) ${r.text}`).join('\n');
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: `Product: ${title}\nReviews:\n${reviewLines}` }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0.4 },
    }),
  );
  const raw = res.output?.message?.content?.[0]?.text;
  if (!raw) throw new Error('empty model response');
  return { digest: parseDigest(raw), usage: res.usage };
}

export const handler = async () => {
  const rows = await scanAll();
  const products = rows.filter((r) => r.sk === 'PRODUCT');

  // group reviews under their product
  const reviewsByProduct = new Map<string, Row[]>();
  rows
    .filter((r) => r.sk.startsWith('REVIEW#'))
    .forEach((r) => {
      const list = reviewsByProduct.get(r.productId) ?? [];
      list.push(r);
      reviewsByProduct.set(r.productId, list);
    });

  if (reviewsByProduct.size === 0) {
    console.log('no reviews to summarize');
    return { ok: false, message: 'no reviews found' };
  }

  const generatedAt = new Date().toISOString();
  const written: string[] = [];

  // one digest per product, stored as sk="DIGEST" in that product's own partition.
  // sequential to stay comfortably under Bedrock rate limits at this scale.
  for (const product of products) {
    const reviews = reviewsByProduct.get(product.productId);
    if (!reviews || reviews.length === 0) continue;
    const title = String(product.title ?? product.productId);

    const ratings = reviews.map((r) => Number(r.rating)).filter((n) => !Number.isNaN(n));
    const averageRating =
      ratings.length > 0 ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null;

    let digest: Digest;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    try {
      ({ digest, usage } = await summarize(title, reviews));
    } catch (err) {
      console.error(`digest failed for ${product.productId}:`, err);
      continue;
    }

    const item = {
      productId: product.productId,
      sk: 'DIGEST',
      title,
      generatedAt,
      reviewCount: reviews.length,
      averageRating,
      tokens: {
        input: usage?.inputTokens ?? null,
        output: usage?.outputTokens ?? null,
        total: usage?.totalTokens ?? null,
      },
      ...digest,
    };
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    written.push(product.productId);
    console.log(`digest written for "${title}": ${reviews.length} reviews, "${digest.overallSentiment}"`);
  }

  return { ok: true, digestsWritten: written.length, generatedAt };
};
