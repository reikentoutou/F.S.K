import { defineBackend } from '@aws-amplify/backend';
import { CfnParameter, Tags } from 'aws-cdk-lib';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';

import { applyProductionAuthOverrides } from './auth/overrides.js';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { kitchenContext } from './functions/kitchen-context/resource.js';
import { APPLICATION_TAGS } from './infrastructure/application-config.js';
import {
  applyProductionStorageBucketOverrides,
  storage,
} from './storage/resource.js';

export const backend = defineBackend({
  auth,
  data,
  storage,
  kitchenContext,
});

const {
  cfnIdentityPool,
  cfnUserPool,
  cfnUserPoolClient,
} = backend.auth.resources.cfnResources;
applyProductionAuthOverrides(cfnUserPool, cfnUserPoolClient);
cfnIdentityPool.allowUnauthenticatedIdentities = false;

applyProductionStorageBucketOverrides(
  backend.storage.resources.cfnResources.cfnBucket,
);

const kitchenGroup = backend.auth.resources.groups.KITCHEN;
if (!kitchenGroup) {
  throw new Error('KITCHEN_GROUP_NOT_FOUND');
}
new Policy(backend.storage.stack, 'KitchenSubmissionWritePolicy', {
  roles: [kitchenGroup.role],
  statements: [
    new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        backend.storage.resources.bucket.arnForObjects(
          'submissions/${cognito-identity.amazonaws.com:sub}/*',
        ),
      ],
    }),
  ],
});

const kitchenContextTables = [
  ['APP_SETTING_TABLE_NAME', 'AppSetting'],
  ['SHIFT_DEFINITION_TABLE_NAME', 'ShiftDefinition'],
  ['RESPONSIBLE_PERSON_TABLE_NAME', 'ResponsiblePerson'],
] as const;

for (const [environmentName, modelName] of kitchenContextTables) {
  const table = backend.data.resources.tables[modelName];
  if (!table) {
    throw new Error(`KITCHEN_CONTEXT_TABLE_NOT_FOUND:${modelName}`);
  }
  table.grantReadData(backend.kitchenContext.resources.lambda);
  backend.kitchenContext.addEnvironment(environmentName, table.tableName);
}

for (const construct of backend.data.stack.node.findAll()) {
  if (!(construct instanceof CfnParameter)) {
    continue;
  }
  if (construct.node.id === 'DynamoDBBillingMode') {
    construct.default = 'PAY_PER_REQUEST';
  }
  if (construct.node.id === 'DynamoDBEnablePointInTimeRecovery') {
    construct.default = 'true';
  }
}

// Amplify's table manager accepts the PITR flag but does not apply it to the live tables.
for (const [modelName, table] of Object.entries(
  backend.data.resources.tables,
)) {
  const enablePointInTimeRecovery = {
    action: 'updateContinuousBackups',
    outputPaths: [],
    parameters: {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TableName: table.tableName,
    },
    service: 'DynamoDB',
  };
  const pitrEnforcer = new AwsCustomResource(
    backend.data.stack,
    `Enable${modelName}PointInTimeRecovery`,
    {
      installLatestAwsSdk: false,
      onCreate: {
        ...enablePointInTimeRecovery,
        physicalResourceId: PhysicalResourceId.of(
          `${modelName}-point-in-time-recovery`,
        ),
      },
      onUpdate: enablePointInTimeRecovery,
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [table.tableArn],
      }),
    },
  );
  pitrEnforcer.node.addDependency(table);
}

for (const stack of [
  backend.auth.stack,
  backend.data.stack,
  backend.storage.stack,
  backend.kitchenContext.stack,
]) {
  for (const [key, value] of Object.entries(APPLICATION_TAGS)) {
    Tags.of(stack).add(key, value);
  }
}
