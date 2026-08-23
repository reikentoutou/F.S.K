import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

let composition: typeof import('./backend.foundation.js');

beforeAll(async () => {
  process.env.AWS_REGION = 'ap-northeast-1';
  process.env.AWS_DEFAULT_REGION = 'ap-northeast-1';
  process.env.CDK_CONTEXT_JSON = JSON.stringify({
    'amplify-backend-name': 'staging',
    'amplify-backend-namespace': 'test-app-id',
    'amplify-backend-type': 'branch',
  });
  composition = await import('./backend.foundation.js');
});

const REQUIRED_TAGS = [
  { Key: 'Project', Value: 'FSK' },
  { Key: 'Environment', Value: 'staging' },
  { Key: 'ManagedBy', Value: 'AmplifyGen2' },
  { Key: 'CostCenter', Value: 'FSK' },
] as const;

describe('foundation backend composition', () => {
  it('exports exactly the approved foundation resource set', () => {
    expect(composition.FOUNDATION_RESOURCE_SET).toEqual([
      'auth',
      'storage',
      'vpc',
      'aurora',
      'dataApi',
    ]);
  });

  it('requires both AWS SDK region variables to match staging', () => {
    expect(() =>
      composition.assertStagingDeploymentRegion({
        AWS_REGION: 'ap-northeast-1',
        AWS_DEFAULT_REGION: 'ap-northeast-1',
      }),
    ).not.toThrow();
  });

  it.each([
    [{ AWS_DEFAULT_REGION: 'ap-northeast-1' }],
    [{ AWS_REGION: 'ap-northeast-1' }],
    [
      {
        AWS_REGION: 'us-east-1',
        AWS_DEFAULT_REGION: 'ap-northeast-1',
      },
    ],
    [
      {
        AWS_REGION: 'ap-northeast-1',
        AWS_DEFAULT_REGION: 'us-east-1',
      },
    ],
  ])('rejects missing or drifting SDK region variables: %j', (environment) => {
    expect(() =>
      composition.assertStagingDeploymentRegion(environment),
    ).toThrow('STAGING_REGION_MISMATCH');
  });

  it('synthesizes the branch deployment without Data or business Functions', () => {
    const app = composition.backend.stack.node.root;
    expect(app).toBeInstanceOf(App);

    const assembly = (app as App).synth({ errorOnDuplicateSynth: false });
    const templates = [
      ['root', composition.backend.stack],
      ['auth', composition.backend.auth.stack],
      ['storage', composition.backend.storage.stack],
      ['foundation', composition.foundationStack],
    ] as const;
    const synthesizedTemplates = templates.map(([name, stack]) => ({
      name,
      template: Template.fromStack(stack),
    }));

    for (const { template } of synthesizedTemplates) {
      template.resourceCountIs('AWS::AppSync::GraphQLApi', 0);
    }

    const rootTemplate = synthesizedTemplates.find(
      ({ name }) => name === 'root',
    )?.template;
    expect(rootTemplate).toBeDefined();

    const rootLambdas = rootTemplate!.findResources('AWS::Lambda::Function');
    const lambdaEntries = Object.entries(rootLambdas);
    expect(lambdaEntries).toHaveLength(2);

    const linkerEntry = lambdaEntries.find(([logicalId]) =>
      /^AmplifyBranchLinkerCustomResourceLambda[A-F0-9]+$/.test(logicalId),
    );
    const providerEntry = lambdaEntries.find(([logicalId]) =>
      /^AmplifyBranchLinkerCustomResourceProviderframeworkonEvent[A-F0-9]+$/.test(
        logicalId,
      ),
    );
    expect(linkerEntry?.[1].Properties).toMatchObject({
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Timeout: 10,
    });
    expect(providerEntry?.[1].Properties).toMatchObject({
      Description: expect.stringContaining(
        '/AmplifyBranchLinker/CustomResourceProvider)',
      ),
      Handler: 'framework.onEvent',
    });
    expect(
      providerEntry?.[1].Properties.Environment.Variables
        .USER_ON_EVENT_FUNCTION_ARN,
    ).toEqual({
      'Fn::GetAtt': [linkerEntry?.[0], 'Arn'],
    });

    for (const { name, template } of synthesizedTemplates) {
      if (name !== 'root') {
        template.resourceCountIs('AWS::Lambda::Function', 0);
      }
    }

    const nestedStacks = rootTemplate!.findResources(
      'AWS::CloudFormation::Stack',
    );
    const nestedStackIds = Object.keys(nestedStacks);
    expect(nestedStackIds).toHaveLength(2);
    expect(nestedStackIds.some((id) => /^auth[A-F0-9]+$/.test(id))).toBe(
      true,
    );
    expect(nestedStackIds.some((id) => /^storage[A-F0-9]+$/.test(id))).toBe(
      true,
    );

    const synthesizedEvidence = JSON.stringify({
      stackNames: assembly.stacks.map((stack) => stack.stackName),
      templates: synthesizedTemplates.map(({ name, template }) => [
        name,
        template.toJSON(),
      ]),
    }).toLowerCase();

    expect(synthesizedEvidence).not.toContain('submitkitchenreport');
    expect(synthesizedEvidence).not.toContain('generatedsqlschema');
    expect(synthesizedEvidence).not.toContain('schema.sql');
    expect(synthesizedEvidence).not.toContain('production');
    expect(
      assembly.stacks.some((stack) => /data/i.test(stack.stackName)),
    ).toBe(false);
  });

  it('disables guest identities and applies the staging Cognito overrides', () => {
    const authTemplate = Template.fromStack(composition.backend.auth.stack);

    authTemplate.hasResourceProperties('AWS::Cognito::IdentityPool', {
      AllowUnauthenticatedIdentities: false,
    });
    authTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: [],
    });
    authTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: [
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ],
    });
  });

  it('applies the staging security and lifecycle overrides to the composed bucket', () => {
    const storageTemplate = Template.fromStack(
      composition.backend.storage.stack,
    );

    storageTemplate.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'pending/', Status: 'Enabled' }),
          Match.objectLike({ Prefix: 'test-exports/', Status: 'Enabled' }),
          Match.objectLike({
            Prefix: 'migration-staging/',
            Status: 'Enabled',
          }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('composes the private foundation in ap-northeast-1 with audit outputs', () => {
    expect(Stack.of(composition.foundationStack).region).toBe(
      'ap-northeast-1',
    );
    expect(composition.foundation.databaseName).toBe('fsk_staging');

    const foundationTemplate = Template.fromStack(
      composition.foundationStack,
    );
    foundationTemplate.hasResourceProperties('AWS::RDS::DBCluster', {
      DatabaseName: 'fsk_staging',
      EnableHttpEndpoint: true,
      ServerlessV2ScalingConfiguration: {
        MaxCapacity: 2,
        MinCapacity: 0,
        SecondsUntilAutoPause: Match.anyValue(),
      },
    });
    foundationTemplate.hasOutput('VpcId', {});
    foundationTemplate.hasOutput('AuroraClusterArn', {});
    foundationTemplate.hasOutput('AuroraSecretArn', {});
    foundationTemplate.hasOutput('DatabaseSecurityGroupId', {});
    foundationTemplate.hasOutput('DatabaseName', { Value: 'fsk_staging' });
  });

  it('tags the Auth, Storage, and Foundation deployment stacks', () => {
    for (const stack of [
      composition.backend.auth.stack,
      composition.backend.storage.stack,
      composition.foundationStack,
    ]) {
      expect(Stack.of(stack).tags.tagValues()).toMatchObject({
        Project: 'FSK',
        Environment: 'staging',
        ManagedBy: 'AmplifyGen2',
        CostCenter: 'FSK',
      });
    }

    const storageTemplate = Template.fromStack(
      composition.backend.storage.stack,
    );
    const buckets = storageTemplate.findResources('AWS::S3::Bucket');
    const [bucket] = Object.values(buckets);

    expect(bucket?.Properties.Tags).toEqual(
      expect.arrayContaining([...REQUIRED_TAGS]),
    );
  });
});
