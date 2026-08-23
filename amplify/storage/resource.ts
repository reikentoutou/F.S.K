import { defineStorage } from '@aws-amplify/backend';
import type { IResolvable } from 'aws-cdk-lib';
import type { CfnBucket } from 'aws-cdk-lib/aws-s3';

const EPHEMERAL_OBJECT_RETENTION_DAYS = 7;

export interface StorageBucketOverrideTarget {
  bucketEncryption?: CfnBucket.BucketEncryptionProperty | IResolvable;
  lifecycleConfiguration?:
    | CfnBucket.LifecycleConfigurationProperty
    | IResolvable;
  publicAccessBlockConfiguration?:
    | CfnBucket.PublicAccessBlockConfigurationProperty
    | IResolvable;
}

export const storage = defineStorage({
  name: 'fskStagingFiles',
  versioned: true,
  keepOnDelete: true,
  // Omitting access keeps every client and backend resource denied by default.
});

export function applyStagingStorageBucketOverrides(
  bucket: StorageBucketOverrideTarget,
): void {
  bucket.publicAccessBlockConfiguration = {
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  };
  bucket.bucketEncryption = {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: {
          sseAlgorithm: 'AES256',
        },
      },
    ],
  };
  bucket.lifecycleConfiguration = {
    rules: [
      ephemeralLifecycleRule('ExpirePendingObjects', 'pending/'),
      ephemeralLifecycleRule('ExpireTestExports', 'exports/'),
      ephemeralLifecycleRule('ExpireMigrationStaging', 'migration-staging/'),
    ],
  };
}

function ephemeralLifecycleRule(
  id: string,
  prefix: string,
): CfnBucket.RuleProperty {
  return {
    expirationInDays: EPHEMERAL_OBJECT_RETENTION_DAYS,
    id,
    noncurrentVersionExpiration: {
      noncurrentDays: EPHEMERAL_OBJECT_RETENTION_DAYS,
    },
    prefix,
    status: 'Enabled',
  };
}
