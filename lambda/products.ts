import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// GET /products — return the PRODUCT items (read-only catalog view for the UI).
export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk = :p',
        ExpressionAttributeValues: { ':p': 'PRODUCT' },
        ExclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as Record<string, any>[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const products = items
    .map((i) => ({
      productId: i.productId,
      title: i.title,
      category: i.category ?? null,
      description: i.description ?? null,
      createdAt: i.createdAt ?? null,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: products.length, products }),
  };
};
