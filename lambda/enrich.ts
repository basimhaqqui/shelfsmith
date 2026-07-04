import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { enrichProduct } from './lib/enrichment';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const enrich = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
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

  // call Bedrock + parse
  let enriched, tokens;
  try {
    ({ enriched, tokens } = await enrichProduct(title, specs));
  } catch (err) {
    console.error('enrichment failed', err);
    return json(502, { error: 'model invocation or parsing failed' });
  }

  // persist to DynamoDB
  const productId = randomUUID();
  const createdAt = new Date().toISOString();
  const item = { productId, sk: 'PRODUCT', title, specs, ...enriched, createdAt, tokens };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    console.error('dynamodb put failed', err);
    return json(502, { error: 'failed to persist product' });
  }

  console.log(`enriched "${title}" — tokens in/out/total: ${tokens.input}/${tokens.output}/${tokens.total}`);
  return json(201, { productId, title, ...enriched, createdAt, tokens });
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    return await enrich(event);
  } catch (err) {
    // Log unexpected failures for CloudWatch, but do not expose implementation
    // details or stack traces to API clients.
    console.error('unexpected enrichment failure', err);
    return json(500, { error: 'internal server error' });
  }
};
