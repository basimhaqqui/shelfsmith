import * as path from 'path';
import { Construct } from 'constructs';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Runtime, FunctionUrlAuthType, InvokeMode, HttpMethod as FnUrlHttpMethod } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const BASE_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const INFERENCE_PROFILE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

export class ShelfSmithStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bedrockResources = [
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
      ...INFERENCE_PROFILE_REGIONS.map(
        (r) => `arn:aws:bedrock:${r}::foundation-model/${BASE_MODEL_ID}`,
      ),
    ];
    const invokeModel = () =>
      new PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: bedrockResources });

    const table = new Table(this, 'CatalogTable', {
      partitionKey: { name: 'productId', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = (
      name: string,
      file: string,
      env: Record<string, string>,
      timeout = 10,
      opts: Partial<NodejsFunctionProps> = {},
    ) =>
      new NodejsFunction(this, name, {
        runtime: Runtime.NODEJS_20_X,
        entry: path.join(__dirname, '..', 'lambda', file),
        handler: 'handler',
        memorySize: 256,
        timeout: Duration.seconds(timeout),
        bundling: { minify: true, externalModules: [] },
        environment: env,
        ...opts,
      });

    // enrich: Bedrock -> persist
    const enrichFn = fn('EnrichFunction', 'enrich.ts', { MODEL_ID, TABLE_NAME: table.tableName }, 30);
    enrichFn.addToRolePolicy(invokeModel());
    enrichFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn] }),
    );

    // stream-enrich: streaming variant over a Lambda Function URL (API Gateway can't stream)
    const streamFn = fn('StreamEnrichFunction', 'stream-enrich.ts', { MODEL_ID, TABLE_NAME: table.tableName }, 60);
    streamFn.addToRolePolicy(
      new PolicyStatement({ actions: ['bedrock:InvokeModelWithResponseStream'], resources: bedrockResources }),
    );
    streamFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn] }),
    );
    const streamUrl = streamFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
      cors: { allowedOrigins: ['*'], allowedMethods: [FnUrlHttpMethod.POST], allowedHeaders: ['content-type'] },
    });

    // ---- bulk enrichment pipeline: CSV -> submit -> SQS fan-out -> workers -> DynamoDB ----
    const enrichDlq = new Queue(this, 'EnrichDLQ', { retentionPeriod: Duration.days(14) });
    const enrichQueue = new Queue(this, 'EnrichQueue', {
      visibilityTimeout: Duration.seconds(360), // >= worker timeout
      deadLetterQueue: { queue: enrichDlq, maxReceiveCount: 3 },
    });

    // bulk-submit: create a job record + enqueue one message per product
    const bulkSubmitFn = fn('BulkSubmitFunction', 'bulk-submit.ts', { TABLE_NAME: table.tableName, QUEUE_URL: enrichQueue.queueUrl }, 30);
    bulkSubmitFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn] }),
    );
    enrichQueue.grantSendMessages(bulkSubmitFn);

    // bulk-worker: enrich one product per SQS message. maxConcurrency caps how many
    // workers run at once to stay under Bedrock rate limits (without reserving account concurrency).
    const bulkWorkerFn = fn('BulkWorkerFunction', 'bulk-worker.ts', { MODEL_ID, TABLE_NAME: table.tableName }, 60);
    bulkWorkerFn.addToRolePolicy(invokeModel());
    bulkWorkerFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], resources: [table.tableArn] }),
    );
    bulkWorkerFn.addEventSource(
      new SqsEventSource(enrichQueue, { batchSize: 5, maxConcurrency: 5, reportBatchItemFailures: true }),
    );

    // bulk-dlq: terminal failures land here; count them so completed + failed == total
    const bulkDlqFn = fn('BulkDlqFunction', 'bulk-dlq.ts', { TABLE_NAME: table.tableName });
    bulkDlqFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [table.tableArn] }),
    );
    bulkDlqFn.addEventSource(new SqsEventSource(enrichDlq, { batchSize: 10 }));

    // bulk-status: poll a job's progress
    const bulkStatusFn = fn('BulkStatusFunction', 'bulk-status.ts', { TABLE_NAME: table.tableName });
    bulkStatusFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [table.tableArn] }),
    );

    // products: read-only catalog list (scan)
    const productsFn = fn('ProductsFunction', 'products.ts', { TABLE_NAME: table.tableName });
    productsFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [table.tableArn] }),
    );

    // get-product: product + its digest from one partition (Query)
    const getProductFn = fn('GetProductFunction', 'get-product.ts', { TABLE_NAME: table.tableName });
    getProductFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:Query'], resources: [table.tableArn] }),
    );

    // update-product: edit + regenerate an existing product's copy (Bedrock -> overwrite)
    const updateFn = fn('UpdateProductFunction', 'update-product.ts', { MODEL_ID, TABLE_NAME: table.tableName }, 30);
    updateFn.addToRolePolicy(invokeModel());
    updateFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [table.tableArn] }),
    );

    // delete-product: remove a product + its reviews
    const deleteFn = fn('DeleteProductFunction', 'delete-product.ts', { TABLE_NAME: table.tableName });
    deleteFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
        resources: [table.tableArn],
      }),
    );

    // get-digest: read every product's review-sentiment digest (Scan for sk="DIGEST")
    const getDigestFn = fn('GetDigestFunction', 'get-digest.ts', { TABLE_NAME: table.tableName });
    getDigestFn.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:Scan'], resources: [table.tableArn] }),
    );

    // review-digest: scan reviews -> Bedrock summary -> persist
    const digestFn = fn('ReviewDigestFunction', 'review-digest.ts', { MODEL_ID, TABLE_NAME: table.tableName }, 60);
    digestFn.addToRolePolicy(invokeModel());
    digestFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:PutItem'],
        resources: [table.tableArn],
      }),
    );

    new Rule(this, 'ReviewDigestSchedule', {
      description: 'Daily ShelfSmith review-sentiment digest',
      schedule: Schedule.rate(Duration.days(1)),
      targets: [new LambdaFunction(digestFn)],
    });

    const httpApi = new HttpApi(this, 'ShelfSmithApi', {
      apiName: 'shelfsmith-api',
      description: 'ShelfSmith product enrichment + catalog endpoints',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({ path: '/enrich', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('EnrichIntegration', enrichFn) });
    httpApi.addRoutes({ path: '/products', methods: [HttpMethod.GET], integration: new HttpLambdaIntegration('ProductsIntegration', productsFn) });
    httpApi.addRoutes({ path: '/products/{id}', methods: [HttpMethod.GET], integration: new HttpLambdaIntegration('GetProductIntegration', getProductFn) });
    httpApi.addRoutes({ path: '/products/{id}', methods: [HttpMethod.PUT], integration: new HttpLambdaIntegration('UpdateIntegration', updateFn) });
    httpApi.addRoutes({ path: '/products/{id}', methods: [HttpMethod.DELETE], integration: new HttpLambdaIntegration('DeleteIntegration', deleteFn) });
    httpApi.addRoutes({ path: '/digest', methods: [HttpMethod.GET], integration: new HttpLambdaIntegration('GetDigestIntegration', getDigestFn) });
    httpApi.addRoutes({ path: '/bulk', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('BulkSubmitIntegration', bulkSubmitFn) });
    httpApi.addRoutes({ path: '/bulk/{jobId}', methods: [HttpMethod.GET], integration: new HttpLambdaIntegration('BulkStatusIntegration', bulkStatusFn) });

    // Static web UI: private S3 + CloudFront (OAC, HTTPS)
    const siteBucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      comment: 'ShelfSmith web UI',
    });
    new BucketDeployment(this, 'WebDeployment', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      sources: [
        Source.asset(path.join(__dirname, '..', 'web')),
        Source.data(
          'config.js',
          `window.SHELFSMITH_API_BASE = "${httpApi.apiEndpoint}";\n` +
            `window.SHELFSMITH_STREAM_URL = "${streamUrl.url}";`,
        ),
      ],
    });

    new CfnOutput(this, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'StreamUrl', { value: streamUrl.url });
    new CfnOutput(this, 'EnrichEndpoint', { value: `${httpApi.apiEndpoint}/enrich` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'DigestFunctionName', { value: digestFn.functionName });
  }
}
