import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const readDocument = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const DEPLOYMENT_RUNBOOK = readDocument(
  join(process.cwd(), 'docs/aws/staging-deployment-runbook.md'),
);
const MIGRATION_RUNBOOK = readDocument(
  join(process.cwd(), 'docs/aws/staging-migration-runbook.md'),
);
const COST_APPROVAL = readDocument(
  join(process.cwd(), 'docs/aws/staging-cost-approval.md'),
);

const extractBashSteps = (document: string): string =>
  [...document.matchAll(/^```bash\n([\s\S]*?)^```$/gm)]
    .map((match) => match[1])
    .join('\n');

const extractBashFunction = (document: string, name: string): string => {
  const match = extractBashSteps(document).match(
    new RegExp(`^${name.replaceAll('_', '[_]')}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'),
  );
  if (!match) {
    throw new Error(`RUNBOOK_FUNCTION_NOT_FOUND:${name}`);
  }
  return match[0];
};

const markdownRows = (document: string): string[][] =>
  document
    .split('\n')
    .filter((line) => /^\|.*\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', '')),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));

const documentFieldValues = (document: string, field: string): string[] =>
  markdownRows(document)
    .filter(([name]) => name === field)
    .map(([, value]) => value);

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
      template.resourceCountIs('AWS::RDS::DBProxy', 0);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
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

    expect(synthesizedEvidence).not.toContain(
      'com.amazonaws.ap-northeast-1.ssm',
    );
    expect(synthesizedEvidence).not.toContain('submitkitchenreport');
    expect(synthesizedEvidence).not.toContain('generatedsqlschema');
    expect(synthesizedEvidence).not.toContain('schema.sql');
    expect(synthesizedEvidence).not.toContain('sqlupdater');
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
        MaxCapacity: 1,
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

describe('staging deployment documentation contracts', () => {
  it('keeps the cost gate unapproved with the six separately approved write stages', () => {
    expect(documentFieldValues(COST_APPROVAL, 'GateStatus')).toContain(
      'NOT_APPROVED',
    );
    expect(documentFieldValues(COST_APPROVAL, 'MonthlyCeilingJpy')).toContain(
      '25000',
    );
    expect(documentFieldValues(COST_APPROVAL, 'LowUseMonthlyJpy')).toContain(
      '约 ¥1,000',
    );
    expect(
      documentFieldValues(COST_APPROVAL, 'OneAcuWorstMonthJpy'),
    ).toContain('约 ¥19,600');

    const stages = markdownRows(COST_APPROVAL)
      .filter(([, , approval]) => approval === 'PENDING_USER_APPROVAL')
      .map(([stage]) => stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        'Foundation',
        'Migration',
        'Full backend',
        'Hosting',
        'Budget/alarms',
        'Destroy',
      ]),
    );
  });

  it('budgets the Data API HTTP backend without persistent connector costs', () => {
    const costItems = markdownRows(COST_APPROVAL).map(([item]) => item);
    expect(costItems).toEqual(
      expect.arrayContaining([
        'API Gateway HTTP API',
        'RDS Data API calls',
        'Kitchen/Admin/Export Functions',
      ]),
    );
    expect(costItems.some((item) => /SSM Interface/i.test(item))).toBe(false);
    expect(costItems.some((item) => /AppSync/i.test(item))).toBe(false);
  });

  it('keeps removed connector operations out of both executable runbooks', () => {
    expect(MIGRATION_RUNBOOK).not.toBe('');
    const executableSteps = [DEPLOYMENT_RUNBOOK, MIGRATION_RUNBOOK]
      .map(extractBashSteps)
      .join('\n');
    const removedOperations = [
      /ampx\s+generate\s+schema-from-database/i,
      /schema[.]sql[.]ts/i,
      /SQL_CONNECTION_STRING/,
      /AppSync/i,
      /SQL[-_ ]?Lambda/i,
      /create-vpc-endpoint[\s\S]{0,300}ssm/i,
      /com[.]amazonaws[.]ap-northeast-1[.]ssm/i,
    ];

    for (const removedOperation of removedOperations) {
      expect(executableSteps).not.toMatch(removedOperation);
    }
  });
});

describe('staging migration runbook executable contracts', () => {
  it('builds complete temporary ownership tags from the approved operation tuple', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_render_temporary_tags')}
fsk_render_temporary_tags
`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_AWS_ACCOUNT_ID: '444083008754',
          FSK_MIGRATION_OPERATION_TOKEN:
            '00000000-0000-4000-8000-000000000000',
          FSK_MIGRATION_TASK_ID: 'task-1',
          FSK_VPC_ID: 'vpc-0123456789abcdef0',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
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

  it('runs the first apply, second no-op, and verify in order without exposing the database URL', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-migration-'));
    const callLogPath = join(fixtureDirectory, 'calls.log');
    const migrateCountPath = join(fixtureDirectory, 'migrate-count');
    const script = `set -euo pipefail
fsk_assert_migration_deadline() { :; }
fsk_build_database_url() { export DATABASE_URL='postgresql://user:super-secret@private/fsk_staging'; }
fsk_publish_worker_status() { printf 'STATUS=%s\\n' "$1"; }
fsk_run_before_migration_deadline() {
  printf '%s\\n' "$*" >> "$FSK_MOCK_CALL_LOG"
  "$@"
}
pnpm() {
  case "$*" in
    'run db:staging:migrate')
      count=0
      if [ -f "$FSK_MOCK_MIGRATE_COUNT" ]; then
        count="$(cat "$FSK_MOCK_MIGRATE_COUNT")"
      fi
      count=$((count + 1))
      printf '%s' "$count" > "$FSK_MOCK_MIGRATE_COUNT"
      if [ "$count" -eq 1 ]; then
        printf 'MIGRATIONS_APPLIED count=1\\n'
      else
        printf 'MIGRATIONS_APPLIED count=0\\n'
      fi
      ;;
    'run db:staging:verify')
      printf 'SCHEMA_VERIFIED business_tables=10 metadata_tables=1 migrations=1\\n'
      ;;
    *) return 91 ;;
  esac
}
FSK_MIGRATION_SHELL_ROLE=worker
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_worker_run_database_migration')}
fsk_worker_run_database_migration
test -z "\${DATABASE_URL+x}"
`;

    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_MOCK_CALL_LOG: callLogPath,
          FSK_MOCK_MIGRATE_COUNT: migrateCountPath,
        },
      });
      const calls = readFileSync(callLogPath, 'utf8').trim().split('\n');

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([
        'pnpm run db:staging:migrate',
        'pnpm run db:staging:migrate',
        'pnpm run db:staging:verify',
      ]);
      expect(result.stdout).toContain('STATUS=READY_FOR_CLEANUP');
      expect(`${result.stdout}${result.stderr}`).not.toContain('super-secret');
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it('runs control-owned cleanup when temporary creation fails', () => {
    const script = `set -euo pipefail
fsk_assert_control_guard() { :; }
fsk_discover_owned_residual_count() { printf '0\\n'; }
fsk_create_temporary_state_parameters() { :; }
fsk_create_temporary_access() { printf 'CREATE_FAILED\\n'; return 73; }
fsk_start_control_watchdog() { printf 'WATCHDOG_STARTED\\n'; }
fsk_wait_for_worker_terminal_status() { :; }
fsk_control_cleanup_owned_resources() { printf 'CONTROL_CLEANUP\\n'; }
fsk_delete_owned_state_parameters() { printf 'DELETE_STATE\\n'; }
fsk_publish_control_status() { printf 'CONTROL_STATUS=%s\\n' "$1"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_exit')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_run_migration')}
fsk_control_run_migration
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    expect(result.status).toBe(73);
    expect(result.stdout).toContain('CREATE_FAILED');
    expect(result.stdout).toContain('CONTROL_CLEANUP');
    expect(result.stdout).toContain('CONTROL_STATUS=CLEANUP_PASS:EXIT_73');
    expect(result.stdout).toContain('DELETE_STATE');
  });

  it('requires three stable zero residual observations before cleanup passes', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-cleanup-'));
    const discoveryCountPath = join(fixtureDirectory, 'discover-count');
    const script = `set -euo pipefail
fsk_delete_owned_temporary_resources_once() { printf 'DELETE\\n'; }
fsk_discover_owned_residual_count() {
  count=0
  if [ -f "$FSK_MOCK_DISCOVERY_COUNT" ]; then
    count="$(cat "$FSK_MOCK_DISCOVERY_COUNT")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$FSK_MOCK_DISCOVERY_COUNT"
  case "$count" in
    1) printf '2\\n' ;;
    *) printf '0\\n' ;;
  esac
}
FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH=$(($(date +%s) + 30))
FSK_STABLE_ZERO_REQUIRED=3
FSK_STABLE_ZERO_MIN_SECONDS=0
FSK_CLEANUP_POLL_SECONDS=0
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_cleanup_owned_resources')}
fsk_control_cleanup_owned_resources
`;

    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_MOCK_DISCOVERY_COUNT: discoveryCountPath,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(Number(readFileSync(discoveryCountPath, 'utf8'))).toBeGreaterThanOrEqual(4);
      expect(result.stdout).toContain('STABLE_ZERO_OBSERVATIONS=3');
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it('recovers the uniquely owned operations security group after response loss', () => {
    const script = `set -euo pipefail
fsk_run_before_migration_deadline() { "$@"; }
aws() { return 55; }
fsk_discover_owned_operations_sg_ids() { printf 'sg-0123456789abcdef0\\n'; }
FSK_VPC_ID=vpc-0123456789abcdef0
FSK_MIGRATION_TASK_ID=task-1
FSK_MIGRATION_OPERATION_TOKEN=00000000-0000-4000-8000-000000000000
FSK_TEMP_EC2_TAGS='[]'
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_require_single_owned_id')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_create_or_recover_operations_sg')}
fsk_create_or_recover_operations_sg
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('sg-0123456789abcdef0');
  });
});
