import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const RUNBOOK_PATH = join(
  process.cwd(),
  'docs/aws/staging-deployment-runbook.md',
);
const RUNBOOK = readFileSync(RUNBOOK_PATH, 'utf8');

const extractBashFunction = (name: string): string => {
  const match = RUNBOOK.match(
    new RegExp(`^${name.replaceAll('_', '[_]')}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'),
  );
  if (!match) {
    throw new Error(`RUNBOOK_FUNCTION_NOT_FOUND:${name}`);
  }
  return match[0];
};

const extractRunbookRange = (start: string, end: string): string => {
  const startIndex = RUNBOOK.indexOf(start);
  const endIndex = RUNBOOK.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`RUNBOOK_RANGE_NOT_FOUND:${start}:${end}`);
  }
  return RUNBOOK.slice(startIndex, endIndex).trim();
};

type StateWriterFixture = {
  call: string;
  name: string;
};

const STATE_WRITER_FIXTURES: StateWriterFixture[] = [
  {
    name: 'fsk_put_task8_worker_status',
    call: 'fsk_put_task8_worker_status TEST_STATUS',
  },
  {
    name: 'fsk_put_task8_control_status',
    call: 'fsk_put_task8_control_status TEST_STATUS',
  },
  {
    name: 'fsk_persist_temp_egress_state',
    call: 'fsk_persist_temp_egress_state',
  },
  {
    name: 'fsk_persist_cleanup_result',
    call: 'fsk_persist_cleanup_result PASS',
  },
];

type StateWriterFailureMode =
  | 'failed_precheck'
  | 'failed_put'
  | 'failed_postcheck';

type StateWriterCallContext = 'conditional' | 'errexit_off';

const runStateWriterFixture = (
  fixture: StateWriterFixture,
  failureMode: StateWriterFailureMode,
  callContext: StateWriterCallContext,
) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-task8-writer-'));
  const mockBinDirectory = join(fixtureDirectory, 'bin');
  const mockAwsPath = join(mockBinDirectory, 'aws');
  const mockTimeoutPath = join(mockBinDirectory, 'timeout');
  const mockAwsLogPath = join(fixtureDirectory, 'aws.log');
  mkdirSync(mockBinDirectory);
  writeFileSync(
    mockTimeoutPath,
    `#!/usr/bin/env bash
set -u
while [ "$#" -gt 0 ]; do
  case "$1" in
    --signal=*|--kill-after=*) shift ;;
    [0-9]*) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`,
  );
  writeFileSync(
    mockAwsPath,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FSK_MOCK_AWS_LOG"
case " $* " in
  *' ssm put-parameter '*)
    if [ "\${FSK_MOCK_PUT_MODE:-success}" = fail ]; then
      exit 47
    fi
    printf '1\\n'
    ;;
  *) exit 64 ;;
esac
`,
  );
  chmodSync(mockTimeoutPath, 0o755);
  chmodSync(mockAwsPath, 0o755);

  const invoke =
    callContext === 'conditional'
      ? `set -e
if ${fixture.call}; then
  helper_status=0
else
  helper_status=$?
fi
exit "$helper_status"`
      : `set +e
${fixture.call}
helper_status=$?
exit "$helper_status"`;
  const script = `set -uo pipefail
MOCK_OWNERSHIP_CALLS=0
fsk_assert_task8_parameter_owned() {
  MOCK_OWNERSHIP_CALLS=$((MOCK_OWNERSHIP_CALLS + 1))
  if [ "$FSK_MOCK_FAILURE_MODE" = failed_precheck ] && \
    [ "$MOCK_OWNERSHIP_CALLS" -eq 1 ]; then
    return 41
  fi
  if [ "$FSK_MOCK_FAILURE_MODE" = failed_postcheck ] && \
    [ "$MOCK_OWNERSHIP_CALLS" -eq 2 ]; then
    return 42
  fi
  return 0
}
fsk_render_task8_state() {
  printf '{"version":2}'
}
fsk_run_before_temp_egress_deadline() {
  "$@"
}
fsk_run_before_cleanup_deadline() {
  shift
  "$@"
}
FSK_TASK8_WORKER_STATUS_PARAMETER=/fsk/test/worker-status
FSK_TASK8_CONTROL_STATUS_PARAMETER=/fsk/test/control-status
FSK_TASK8_STATE_PARAMETER=/fsk/test/state
${extractBashFunction(fixture.name)}
${invoke}
`;

  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FSK_MOCK_AWS_LOG: mockAwsLogPath,
        FSK_MOCK_FAILURE_MODE: failureMode,
        FSK_MOCK_PUT_MODE: failureMode === 'failed_put' ? 'fail' : 'success',
        PATH: `${mockBinDirectory}:${process.env.PATH ?? ''}`,
      },
      timeout: 5_000,
    });
    return {
      ...result,
      awsCalls: existsSync(mockAwsLogPath)
        ? readFileSync(mockAwsLogPath, 'utf8').trim().split('\n')
        : [],
    };
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
};

const extractTemporaryEc2TagCalls = () => {
  const lines = RUNBOOK.split('\n');
  return lines.flatMap((line, index) => {
    if (!line.includes('--tag-specifications') ||
        !line.includes('${FSK_TEMP_EC2_TAGS}')) {
      return [];
    }
    const operationLine = lines
      .slice(Math.max(0, index - 12), index + 1)
      .reverse()
      .find((candidate) => candidate.includes('aws ec2 '));
    const operation = operationLine?.match(/aws ec2 ([a-z-]+)/)?.[1];
    const specification = line.match(/--tag-specifications "(.*)" \\/)?.[1];
    if (!operation || !specification) {
      throw new Error(`RUNBOOK_TAGGED_CREATE_PARSE_FAILED:${index + 1}`);
    }
    return [{ operation, specification }];
  });
};

const expandTemporaryEc2Tags = (): string => {
  const assignment = RUNBOOK.match(/^FSK_TEMP_EC2_TAGS=.*$/m)?.[0];
  if (!assignment) {
    throw new Error('RUNBOOK_TEMP_EC2_TAG_ASSIGNMENT_NOT_FOUND');
  }
  const result = spawnSync(
    'bash',
    ['-c', `${assignment}\nprintf '%s' "$FSK_TEMP_EC2_TAGS"`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSK_AWS_ACCOUNT_ID: '444083008754',
        FSK_CLOUDSHELL_TASK_ID: 'task-1',
        FSK_TASK8_OPERATION_TOKEN: '00000000-0000-4000-8000-000000000000',
        FSK_VPC_ID: 'vpc-0123456789abcdef0',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`RUNBOOK_TEMP_EC2_TAG_EXPANSION_FAILED:${result.stderr}`);
  }
  return result.stdout;
};

const AWS_CLI_AVAILABLE = spawnSync('aws', ['--version'], {
  encoding: 'utf8',
}).status === 0;

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

describe('Task 8 runbook executable contracts', () => {
  for (const fixture of STATE_WRITER_FIXTURES) {
    describe(fixture.name, () => {
      it.each<StateWriterCallContext>(['conditional', 'errexit_off'])(
        'does not write and returns failure after an ownership precheck failure in %s context',
        (callContext) => {
          const result = runStateWriterFixture(
            fixture,
            'failed_precheck',
            callContext,
          );

          expect(result.status, result.stderr).not.toBe(0);
          expect(
            result.awsCalls.filter((call) => call.includes('put-parameter')),
          ).toHaveLength(0);
        },
      );

      it.each<StateWriterCallContext>(['conditional', 'errexit_off'])(
        'returns failure when put-parameter fails in %s context',
        (callContext) => {
          const result = runStateWriterFixture(
            fixture,
            'failed_put',
            callContext,
          );

          expect(result.status, result.stderr).not.toBe(0);
          expect(
            result.awsCalls.filter((call) => call.includes('put-parameter')),
          ).toHaveLength(1);
        },
      );

      it.each<StateWriterCallContext>(['conditional', 'errexit_off'])(
        'returns failure when the ownership postcheck fails in %s context',
        (callContext) => {
          const result = runStateWriterFixture(
            fixture,
            'failed_postcheck',
            callContext,
          );

          expect(result.status, result.stderr).not.toBe(0);
          expect(
            result.awsCalls.filter((call) => call.includes('put-parameter')),
          ).toHaveLength(1);
        },
      );
    });
  }

  it('builds temporary EC2 tags as a canonical JSON array', () => {
    const expandedTags = expandTemporaryEc2Tags();
    let parsedTags: unknown;

    expect(() => {
      parsedTags = JSON.parse(expandedTags);
    }).not.toThrow();
    expect(parsedTags).toEqual([
      { Key: 'Project', Value: 'FSK' },
      { Key: 'Environment', Value: 'staging' },
      { Key: 'ManagedBy', Value: 'AmplifyGen2' },
      { Key: 'CostCenter', Value: 'FSK' },
      { Key: 'AccountId', Value: '444083008754' },
      { Key: 'VpcId', Value: 'vpc-0123456789abcdef0' },
      { Key: 'TaskId', Value: 'task-1' },
      {
        Key: 'OperationToken',
        Value: '00000000-0000-4000-8000-000000000000',
      },
    ]);
  });

  (AWS_CLI_AVAILABLE ? it : it.skip)(
    'passes every actual temporary tagged create through the local AWS CLI parser',
    () => {
      const expandedTags = expandTemporaryEc2Tags();
      const taggedCalls = extractTemporaryEc2TagCalls();
      const skeletonArguments: Record<string, string[]> = {
        'allocate-address': [
          '--domain',
          'vpc',
          '--query',
          'AllocationId',
        ],
        'authorize-security-group-ingress': [
          '--group-id',
          'sg-0123456789abcdef0',
          '--protocol',
          'tcp',
          '--port',
          '5432',
          '--source-group',
          'sg-abcdef01234567890',
          '--query',
          'SecurityGroupRules[0].SecurityGroupRuleId',
        ],
        'create-internet-gateway': [
          '--query',
          'InternetGateway.InternetGatewayId',
        ],
        'create-nat-gateway': [
          '--connectivity-type',
          'public',
          '--subnet-id',
          'subnet-0123456789abcdef0',
          '--allocation-id',
          'eipalloc-0123456789abcdef0',
          '--query',
          'NatGateway.NatGatewayId',
        ],
        'create-route-table': [
          '--vpc-id',
          'vpc-0123456789abcdef0',
          '--query',
          'RouteTable.RouteTableId',
        ],
        'create-security-group': [
          '--vpc-id',
          'vpc-0123456789abcdef0',
          '--group-name',
          'fsk-test',
          '--description',
          'test',
          '--query',
          'GroupId',
        ],
        'create-subnet': [
          '--vpc-id',
          'vpc-0123456789abcdef0',
          '--cidr-block',
          '10.0.128.0/24',
          '--availability-zone',
          'ap-northeast-1a',
          '--query',
          'Subnet.SubnetId',
        ],
      };
      expect(taggedCalls.map(({ operation }) => operation).sort()).toEqual(
        Object.keys(skeletonArguments).sort(),
      );

      for (const { operation, specification } of taggedCalls) {
        const result = spawnSync(
          'aws',
          [
            'ec2',
            operation,
            '--generate-cli-skeleton',
            'output',
            '--region',
            'ap-northeast-1',
            ...skeletonArguments[operation],
            '--tag-specifications',
            specification
              .replace('${FSK_TEMP_EC2_TAGS}', expandedTags)
              .replaceAll('\\"', '"'),
            '--output',
            'text',
          ],
          { encoding: 'utf8' },
        );
        expect(result.status, `${operation}: ${result.stderr}`).toBe(0);
      }
    },
  );

  it.each([
    ['real TAB', 'vpc-0123456789abcdef0\tvpc-0123456789abcdef0'],
    ['mixed whitespace', 'vpc-0123456789abcdef0   \tvpc-0123456789abcdef0'],
  ])(
    'accepts exactly two application route-table VPC IDs separated by %s',
    (_fixtureName, routeTableVpcIds) => {
      const guard = extractRunbookRange(
        'FSK_VERIFIED_APPLICATION_ROUTE_TABLE_VPC_IDS=',
        'FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT=',
      );
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
FSK_VPC_ID=vpc-0123456789abcdef0
FSK_APP_ROUTE_TABLE_A_ID=rtb-a
FSK_APP_ROUTE_TABLE_B_ID=rtb-b
fsk_run_before_temp_egress_deadline() {
  printf '%s\\n' "$FSK_MOCK_ROUTE_TABLE_VPCS"
}
${guard}
`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FSK_MOCK_ROUTE_TABLE_VPCS: routeTableVpcIds,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    ['one ID', 'vpc-0123456789abcdef0'],
    [
      'three IDs',
      'vpc-0123456789abcdef0\tvpc-0123456789abcdef0\tvpc-0123456789abcdef0',
    ],
    ['one foreign VPC', 'vpc-0123456789abcdef0\tvpc-foreign'],
  ])('rejects application route-table VPC output with %s', (_name, output) => {
    const guard = extractRunbookRange(
      'FSK_VERIFIED_APPLICATION_ROUTE_TABLE_VPC_IDS=',
      'FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT=',
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
FSK_VPC_ID=vpc-0123456789abcdef0
FSK_APP_ROUTE_TABLE_A_ID=rtb-a
FSK_APP_ROUTE_TABLE_B_ID=rtb-b
fsk_run_before_temp_egress_deadline() {
  printf '%s\\n' "$FSK_MOCK_ROUTE_TABLE_VPCS"
}
${guard}
`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FSK_MOCK_ROUTE_TABLE_VPCS: output },
      },
    );

    expect(result.status, result.stderr).not.toBe(0);
  });

  it('recovers only the exact owned DB ingress rule after response loss', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-db-ingress-'));
    const awsLogPath = join(fixtureDirectory, 'aws.log');
    const ownedTags = [
      { Key: 'Project', Value: 'FSK' },
      { Key: 'Environment', Value: 'staging' },
      { Key: 'ManagedBy', Value: 'AmplifyGen2' },
      { Key: 'CostCenter', Value: 'FSK' },
      { Key: 'AccountId', Value: '444083008754' },
      { Key: 'VpcId', Value: 'vpc-0123456789abcdef0' },
      { Key: 'TaskId', Value: 'task-1' },
      {
        Key: 'OperationToken',
        Value: '00000000-0000-4000-8000-000000000000',
      },
    ];
    const rules = {
      SecurityGroupRules: [
        {
          SecurityGroupRuleId: 'sgr-owned',
          GroupId: 'sg-database',
          GroupOwnerId: '444083008754',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          ReferencedGroupInfo: {
            GroupId: 'sg-operations',
            UserId: '444083008754',
          },
          Tags: ownedTags,
        },
        {
          SecurityGroupRuleId: 'sgr-foreign-reference',
          GroupId: 'sg-database',
          GroupOwnerId: '444083008754',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          ReferencedGroupInfo: {
            GroupId: 'sg-foreign',
            UserId: '444083008754',
          },
          Tags: ownedTags,
        },
        {
          SecurityGroupRuleId: 'sgr-wrong-port',
          GroupId: 'sg-database',
          GroupOwnerId: '444083008754',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          ReferencedGroupInfo: {
            GroupId: 'sg-operations',
            UserId: '444083008754',
          },
          Tags: ownedTags,
        },
        {
          SecurityGroupRuleId: 'sgr-wrong-owner',
          GroupId: 'sg-database',
          GroupOwnerId: '444083008754',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          ReferencedGroupInfo: {
            GroupId: 'sg-operations',
            UserId: '444083008754',
          },
          Tags: ownedTags.map((tag) =>
            tag.Key === 'OperationToken'
              ? { ...tag, Value: '11111111-1111-4111-8111-111111111111' }
              : tag,
          ),
        },
      ],
    };
    const responseLossBlock = extractRunbookRange(
      'if ! FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="$(',
      '\n\nif ! FSK_TEMP_IGW_ID=',
    );
    const script = `set -euo pipefail
FSK_AWS_ACCOUNT_ID=444083008754
FSK_VPC_ID=vpc-0123456789abcdef0
FSK_CLOUDSHELL_TASK_ID=task-1
FSK_TASK8_OPERATION_TOKEN=00000000-0000-4000-8000-000000000000
FSK_DB_SECURITY_GROUP_ID=sg-database
FSK_OPS_SECURITY_GROUP_ID=sg-operations
FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID=''
FSK_TEMP_EC2_TAGS='[]'
fsk_run_before_temp_egress_deadline() {
  printf '%s\\n' "$*" >> "$FSK_MOCK_AWS_LOG"
  case " $* " in
    *' ec2 authorize-security-group-ingress '*) return 55 ;;
    *' ec2 describe-security-group-rules '*)
      case "$*" in
        *Name=referenced-group-id*) return 65 ;;
      esac
      printf '%s' "$FSK_MOCK_RULES_JSON"
      ;;
    *) return 66 ;;
  esac
}
fsk_persist_temp_egress_state() { :; }
${extractBashFunction('fsk_select_owned_database_ingress_rule_ids')}
${extractBashFunction('fsk_require_single_owned_id')}
${responseLossBlock}
printf 'RESULT=%s\\n' "$FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID"
`;

    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_MOCK_AWS_LOG: awsLogPath,
          FSK_MOCK_RULES_JSON: JSON.stringify(rules),
        },
      });
      const awsCalls = existsSync(awsLogPath)
        ? readFileSync(awsLogPath, 'utf8')
        : '';

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('RESULT=sgr-owned');
      expect(awsCalls).toContain('Name=group-id,Values=sg-database');
      expect(awsCalls).toContain(
        'Name=tag:OperationToken,Values=00000000-0000-4000-8000-000000000000',
      );
      expect(awsCalls).not.toContain('Name=referenced-group-id');
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  (AWS_CLI_AVAILABLE ? it : it.skip)(
    'uses only filter names documented by the installed security-group-rule CLI',
    () => {
      const result = spawnSync(
        'aws',
        ['ec2', 'describe-security-group-rules', 'help'],
        { encoding: 'utf8' },
      );
      const help = result.stdout.replace(/.\u0008/g, '');

      expect(result.status, result.stderr).toBe(0);
      expect(help).toContain('group-id');
      expect(help).toMatch(/tag\s*:<key>/);
      expect(help).not.toContain('referenced-group-id');
    },
  );
});
