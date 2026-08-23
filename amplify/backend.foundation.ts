import { defineBackend } from '@aws-amplify/backend';
import {
  App,
  CfnOutput,
  Stack,
  Tags,
} from 'aws-cdk-lib';

import { applyStagingAuthOverrides } from './auth/overrides.js';
import { auth } from './auth/resource.js';
import {
  STAGING_CONFIG,
  STAGING_TAGS,
} from './infrastructure/staging-config.js';
import { createStagingFoundation } from './infrastructure/staging-foundation.js';
import {
  applyStagingStorageBucketOverrides,
  storage,
} from './storage/resource.js';

export const FOUNDATION_RESOURCE_SET = [
  'auth',
  'storage',
  'vpc',
  'aurora',
  'dataApi',
] as const;

export interface StagingDeploymentRegionEnvironment {
  readonly AWS_REGION?: string;
  readonly AWS_DEFAULT_REGION?: string;
}

export function assertStagingDeploymentRegion(
  environment: StagingDeploymentRegionEnvironment,
): void {
  if (
    environment.AWS_REGION !== STAGING_CONFIG.region ||
    environment.AWS_DEFAULT_REGION !== STAGING_CONFIG.region
  ) {
    throw new Error(
      `STAGING_REGION_MISMATCH: AWS_REGION and AWS_DEFAULT_REGION must both equal ${STAGING_CONFIG.region}`,
    );
  }
}

assertStagingDeploymentRegion(process.env);

export const backend = defineBackend({ auth, storage });

const app = backend.stack.node.root;
if (!(app instanceof App)) {
  throw new Error('Amplify backend root must be a CDK App');
}

// The Amplify root stack is environment-agnostic. This sibling stack pins the
// only supported staging region and is included by pipeline-deploy --all.
export const foundationStack = new Stack(app, 'FskStagingFoundation', {
  env: { region: STAGING_CONFIG.region },
  description: 'Private FSK Amplify Gen 2 staging foundation',
});
export const foundation = createStagingFoundation(
  foundationStack,
  STAGING_CONFIG,
);

const {
  cfnIdentityPool,
  cfnUserPool,
  cfnUserPoolClient,
} = backend.auth.resources.cfnResources;
applyStagingAuthOverrides(cfnUserPool, cfnUserPoolClient);
cfnIdentityPool.allowUnauthenticatedIdentities = false;

applyStagingStorageBucketOverrides(
  backend.storage.resources.cfnResources.cfnBucket,
);

for (const stack of [
  backend.stack,
  backend.auth.stack,
  backend.storage.stack,
  foundationStack,
]) {
  for (const [key, value] of Object.entries(STAGING_TAGS)) {
    Tags.of(stack).add(key, value);
  }
}

new CfnOutput(foundationStack, 'VpcId', {
  value: foundation.vpc.vpcId,
});
new CfnOutput(foundationStack, 'AuroraClusterArn', {
  value: foundation.cluster.clusterArn,
});
new CfnOutput(foundationStack, 'AuroraSecretArn', {
  value: foundation.clusterSecret.secretArn,
});
new CfnOutput(foundationStack, 'DatabaseSecurityGroupId', {
  value: foundation.databaseSecurityGroup.securityGroupId,
});
new CfnOutput(foundationStack, 'DatabaseName', {
  value: foundation.databaseName,
});
new CfnOutput(backend.auth.stack, 'UserPoolId', {
  value: backend.auth.resources.userPool.userPoolId,
});
new CfnOutput(backend.auth.stack, 'IdentityPoolId', {
  value: backend.auth.resources.identityPoolId,
});
new CfnOutput(backend.storage.stack, 'StorageBucketName', {
  value: backend.storage.resources.bucket.bucketName,
});
