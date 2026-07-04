import type { SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// Dead-letter consumer: a message lands here after exhausting its retries, so it's a
// terminal failure. Increment the job's failed counter so completed + failed == total.
export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const { jobId } = JSON.parse(record.body);
      if (!jobId) continue;
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { productId: `JOB#${jobId}`, sk: 'JOB' },
          UpdateExpression: 'ADD failed :one',
          ExpressionAttributeValues: { ':one': 1 },
        }),
      );
    } catch (err) {
      console.error('dlq handler error', err);
    }
  }
};
