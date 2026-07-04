import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// GET /bulk/{jobId} — progress for a bulk job. `done` is derived so the UI can stop polling.
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) return json(400, { error: 'jobId is required' });

  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { productId: `JOB#${jobId}`, sk: 'JOB' } }),
  );
  if (!res.Item) return json(404, { error: 'job not found' });

  const { total = 0, completed = 0, failed = 0 } = res.Item as Record<string, number>;
  const done = completed + failed >= total;
  return json(200, { ...res.Item, done });
};
