import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// GET /digest — per-product review-sentiment digests (one per product with reviews).
// Each digest is stored as sk = "DIGEST" in its product's partition, so a filtered
// Scan collects them all. At real scale a GSI on sk would replace this Scan.
export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const digests: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk = :d',
        ExpressionAttributeValues: { ':d': 'DIGEST' },
        ExclusiveStartKey,
      }),
    );
    digests.push(...((res.Items ?? []) as Record<string, any>[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  digests.sort((a, b) => String(a.title).localeCompare(String(b.title)));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: digests.length, digests }),
  };
};
