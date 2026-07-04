import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { enrichProduct } from './lib/enrichment';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// PUT /products/{id} — re-run enrichment for an existing product (edit title/specs
// and regenerate its copy). Preserves productId + createdAt; overwrites the PRODUCT row.
const update = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: 'product id is required' });

  let input: { title?: string; specs?: unknown };
  try {
    input = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'request body must be valid JSON' });
  }

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { productId: id, sk: 'PRODUCT' } }),
  );
  if (!existing.Item) return json(404, { error: 'product not found' });

  // fall back to the current values when a field is omitted
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : String(existing.Item.title);
  const specs = input.specs !== undefined ? input.specs : existing.Item.specs ?? null;

  let enriched, tokens;
  try {
    ({ enriched, tokens } = await enrichProduct(title, specs));
  } catch (err) {
    console.error('enrichment failed', err);
    return json(502, { error: 'model invocation or parsing failed' });
  }

  const updatedAt = new Date().toISOString();
  const item = {
    productId: id,
    sk: 'PRODUCT',
    title,
    specs,
    ...enriched,
    createdAt: existing.Item.createdAt ?? updatedAt,
    updatedAt,
    tokens,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  console.log(`updated "${title}" (${id}) — tokens total: ${tokens.total}`);
  return json(200, item);
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    return await update(event);
  } catch (err) {
    console.error('unexpected update failure', err);
    return json(500, { error: 'internal server error' });
  }
};
