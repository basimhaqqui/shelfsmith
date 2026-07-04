import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const MAX_ITEMS = 500;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// POST /bulk — create a job, then fan the products out to SQS (one message each).
// Returns immediately with a jobId; the workers do the actual enrichment.
const submit = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let input: { products?: { title?: string; specs?: string }[] };
  try {
    input = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'request body must be valid JSON' });
  }

  const items = Array.isArray(input.products) ? input.products : [];
  const clean = items
    .map((p) => ({ title: typeof p.title === 'string' ? p.title.trim() : '', specs: typeof p.specs === 'string' ? p.specs : '' }))
    .filter((p) => p.title)
    .slice(0, MAX_ITEMS);
  if (!clean.length) return json(400, { error: 'no valid products — each row needs a title' });

  const jobId = randomUUID();
  const createdAt = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { productId: `JOB#${jobId}`, sk: 'JOB', jobId, status: 'processing', total: clean.length, completed: 0, failed: 0, createdAt },
    }),
  );

  // SQS SendMessageBatch takes up to 10 entries per call
  for (let i = 0; i < clean.length; i += 10) {
    const chunk = clean.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: chunk.map((p, idx) => ({
          Id: String(i + idx),
          MessageBody: JSON.stringify({ jobId, title: p.title, specs: p.specs }),
        })),
      }),
    );
  }

  console.log(`bulk job ${jobId}: enqueued ${clean.length} products`);
  return json(202, { jobId, total: clean.length, dropped: Math.max(0, items.length - clean.length) });
};

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    return await submit(event);
  } catch (err) {
    console.error('bulk submit failed', err);
    return json(500, { error: 'internal server error' });
  }
};
