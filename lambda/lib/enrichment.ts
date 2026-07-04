import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { extractJsonObject } from './parse';

const bedrock = new BedrockRuntimeClient({});
const MODEL_ID = process.env.MODEL_ID!;

const SYSTEM_PROMPT = `You are a product-content writer for an e-commerce consumer-electronics catalog
(audio gear, appliances, vehicle accessories). Given a raw product, write polished catalog content.
Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
  "description": string, a 2-3 sentence marketing description,
  "category": string, a concise product category,
  "features": array of 3-5 short bullet-point feature strings,
  "keywords": array of 5-8 lowercase SEO keyword strings.`;

export interface Enriched {
  description: string;
  category: string;
  features: string[];
  keywords: string[];
}

export interface Tokens {
  input: number | null;
  output: number | null;
  total: number | null;
}

export function parseEnriched(raw: string): Enriched {
  const obj = extractJsonObject(raw);
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

// Shared by POST /enrich and PUT /products/{id}: run the model + parse defensively.
export async function enrichProduct(
  title: string,
  specs: unknown,
): Promise<{ enriched: Enriched; tokens: Tokens }> {
  const userPrompt =
    `Title: ${title}\n` + `Specs: ${typeof specs === 'string' ? specs : JSON.stringify(specs)}`;

  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.5 },
    }),
  );
  const raw = res.output?.message?.content?.[0]?.text;
  if (!raw) throw new Error('empty model response');

  return {
    enriched: parseEnriched(raw),
    tokens: {
      input: res.usage?.inputTokens ?? null,
      output: res.usage?.outputTokens ?? null,
      total: res.usage?.totalTokens ?? null,
    },
  };
}
