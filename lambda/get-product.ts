import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// GET /products/{id} — fetch one product's full record (efficient single-item GetItem).
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: 'product id is required' });

  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { productId: id, sk: 'PRODUCT' } }),
  );
  if (!res.Item) return json(404, { error: 'product not found' });
  return json(200, res.Item);
};
