import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// GET /digest — latest review-sentiment digest. Digests live under productId "DIGEST"
// with the ISO timestamp as the sort key, so newest-first + limit 1 gets the current one.
export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'productId = :d',
      ExpressionAttributeValues: { ':d': 'DIGEST' },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const digest = res.Items?.[0];
  if (!digest) return json(404, { error: 'no digest yet — the scheduled job has not run' });
  return json(200, digest);
};
