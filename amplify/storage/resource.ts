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

type ProductionStorageAccess = NonNullable<
  Parameters<typeof defineStorage>[0]['access']
>;

export const productionStorageAccess: ProductionStorageAccess = (allow) => ({
  'submissions/{entity_id}/*': [
    allow.entity('identity').to(['write']),
    allow.groups(['OWNER']).to(['read', 'write', 'delete']),
  ],
  'daily-reports/*': [
    allow.groups(['OWNER']).to(['read', 'write', 'delete']),
  ],
  'migration/*': [
    allow.groups(['OWNER']).to(['read', 'write', 'delete']),
  ],
});

export const storage = defineStorage({
  name: 'fskStagingFiles',
  versioned: true,
  keepOnDelete: true,
  access: productionStorageAccess,
});

export function applyProductionStorageBucketOverrides(
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
}

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
      ephemeralLifecycleRule('ExpireTestExports', 'test-exports/'),
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
