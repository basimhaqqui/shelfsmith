import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// DELETE /products/{id} — remove the product and all of its reviews (same partition).
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: 'product id is required' });

  // gather every item under this productId (PRODUCT + REVIEW# rows)
  const items: { productId: string; sk: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'productId = :id',
        ExpressionAttributeValues: { ':id': id },
        ProjectionExpression: 'productId, sk',
        ExclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as { productId: string; sk: string }[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (items.length === 0) return json(404, { error: 'product not found' });

  await Promise.all(
    items.map((it) =>
      ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { productId: id, sk: it.sk } })),
    ),
  );
  return json(200, { deleted: items.length, productId: id });
};
