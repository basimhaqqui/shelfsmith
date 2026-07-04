import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// GET /products/{id} — the product's full record plus its review digest. Both live
// in the same partition, so a single Query returns them together.
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: 'product id is required' });

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'productId = :id',
      ExpressionAttributeValues: { ':id': id },
    }),
  );
  const items = res.Items ?? [];
  const product = items.find((i) => i.sk === 'PRODUCT');
  if (!product) return json(404, { error: 'product not found' });

  const digest = items.find((i) => i.sk === 'DIGEST') ?? null;
  return json(200, { ...product, digest });
};
