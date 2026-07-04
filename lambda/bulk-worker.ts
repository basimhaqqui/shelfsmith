import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { enrichProduct } from './lib/enrichment';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// atomic counter bump on the job record
async function bump(jobId: string, field: 'completed' | 'failed') {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { productId: `JOB#${jobId}`, sk: 'JOB' },
      UpdateExpression: 'ADD #f :one',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':one': 1 },
    }),
  );
}

// SQS consumer: enrich one product per message. Reports per-message failures so
// only the failed messages are retried (and eventually dead-lettered), not the batch.
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let msg: { jobId: string; title: string; specs?: string };
    try {
      msg = JSON.parse(record.body);
    } catch {
      console.error('unparseable message, dropping', record.messageId);
      continue; // poison message — don't retry a malformed body
    }

    try {
      const { enriched, tokens } = await enrichProduct(msg.title, msg.specs || null);
      const productId = randomUUID();
      const createdAt = new Date().toISOString();
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { productId, sk: 'PRODUCT', title: msg.title, specs: msg.specs || null, ...enriched, createdAt, tokens, source: 'bulk' },
        }),
      );
      await bump(msg.jobId, 'completed');
    } catch (err) {
      // transient (e.g. Bedrock throttling) — let SQS retry; the DLQ worker counts terminal failures
      console.error(`enrich failed for "${msg.title}":`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
