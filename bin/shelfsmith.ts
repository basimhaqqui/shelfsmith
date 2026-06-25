#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ShelfSmithStack } from '../lib/shelfsmith-stack';

const app = new cdk.App();

new ShelfSmithStack(app, 'ShelfSmithStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'ShelfSmith — serverless AI product-content engine (interview demo)',
});
