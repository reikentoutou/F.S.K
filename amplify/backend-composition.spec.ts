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

const extractBashDefaultAssignment = (
  document: string,
  variable: string,
): string => {
  const prefix = `: "\${${variable}:=`;
  const match = extractBashSteps(document)
    .split('\n')
    .find((line) => line.startsWith(prefix) && line.endsWith('}"'));
  if (!match) {
    throw new Error(`RUNBOOK_DEFAULT_NOT_FOUND:${variable}`);
  }
  return match;
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

const parseJpyAmount = (value: string): number => {
  const match = value.match(/^(?:约 ¥)?([0-9][0-9,]*)$/);
  const amount = Number(match?.[1].replaceAll(',', ''));
  if (!match || !Number.isSafeInteger(amount)) {
    throw new Error(`INVALID_JPY_AMOUNT:${value}`);
  }
  return amount;
};

const FOUNDATION_APPROVAL_EVIDENCE = {
  ApprovalId: [
    'FSK-FOUNDATION-20260823-221547-JST',
    'FSK-FOUNDATION-20260823-221547-JST',
  ],
  Approver: ['reiken', 'reiken'],
  ApprovedAtJst: [
    '2026-08-23 22:15:47 JST',
    '2026-08-23 22:15:47 JST',
  ],
  ExpiresAtJst: [
    '2026-08-24 22:15:47 JST',
    '2026-08-24 22:15:47 JST',
  ],
  ApprovalScope: [
    'Foundation only: remote tag/staging branch + Auth/Storage/VPC/Aurora/Data API',
  ],
  UserApprovalStatement: [
    '批准将 fsk-staging-data-api-foundation-v1 推送到远程，并在 AWS 账号 444083008754、ap-northeast-1 创建独立 FSK staging Foundation；月治理上限 ¥5,000，不包含完整 backend、Hosting、Budget/alarms、销毁或真实数据迁移。',
  ],
  ApprovalMessageOrTaskId: [
    'Codex task user message at 2026-08-23 22:15:47 JST',
  ],
  ApprovedStage: ['Foundation'],
  ApprovedCommit: ['dcff57ebc9bc6d77fbb51072b996834f5a5ca715'],
  CostOwner: ['reiken', 'reiken'],
  CleanupOwner: ['reiken', 'reiken'],
};

const MIGRATION_APPROVAL_EVIDENCE = {
  GateStatus: ['APPROVED_MIGRATION'],
  MigrationApprovalId: ['FSK-MIGRATION-20260824-145858-JST'],
  'FoundationCommit/Tag/RemoteBranch': [
    'dcff57ebc9bc6d77fbb51072b996834f5a5ca715 / fsk-staging-data-api-foundation-v1 / staging',
  ],
  TaskId: ['migration-20260824'],
  OperationToken: ['c4c4eb7f-5665-4039-975f-554f36a8fae0'],
  OperationDeadlineEpoch: ['1787558338 / 2026-08-24 16:58:58 JST'],
  CleanupDeadlineEpoch: ['1787561038 / 2026-08-24 17:43:58 JST'],
  'TemporaryPublicCidr/Az': ['10.42.4.0/24 / ap-northeast-1a'],
  ApplicationRouteTableIds: [
    'rtb-0bbea56ee741ffe5f / rtb-0b08168b07de52b49',
  ],
  CostOwner: ['reiken'],
  CleanupOwner: ['reiken'],
} as const;

const preBindingApprovalEvidence = (
  document: string,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.keys(FOUNDATION_APPROVAL_EVIDENCE).map((field) => [
      field,
      documentFieldValues(document, field),
    ]),
  );

const OWNERSHIP_TAGS = [
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
] as const;

const OWNERSHIP_ENVIRONMENT = {
  FSK_AWS_ACCOUNT_ID: '444083008754',
  FSK_MIGRATION_OPERATION_TOKEN: '00000000-0000-4000-8000-000000000000',
  FSK_MIGRATION_TASK_ID: 'task-1',
  FSK_VPC_ID: 'vpc-0123456789abcdef0',
} as const;

const runWithMockAws = (
  script: string,
  mockAwsBody: string,
  environment: Record<string, string> = {},
  timeout = 5_000,
) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-mock-aws-'));
  const binDirectory = join(fixtureDirectory, 'bin');
  const awsPath = join(binDirectory, 'aws');
  const timeoutPath = join(binDirectory, 'timeout');
  const callLogPath = join(fixtureDirectory, 'aws.log');
  mkdirSync(binDirectory);
  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FSK_MOCK_AWS_LOG"
${mockAwsBody}
`,
  );
  writeFileSync(
    timeoutPath,
    `#!/usr/bin/env bash
set -u
while [ "$#" -gt 0 ]; do
  case "$1" in
    --signal=*|--kill-after=*) shift ;;
    [0-9]*) seconds="$1"; shift; break ;;
    *) exit 125 ;;
  esac
done
marker="$(mktemp)"
"$@" & child=$!
(
  sleep "$seconds"
  printf 'expired' > "$marker"
  kill -TERM "$child" 2>/dev/null || true
  sleep 0.1
  kill -KILL "$child" 2>/dev/null || true
) >/dev/null 2>&1 & watchdog=$!
set +e
wait "$child"
status=$?
set -e
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [ -s "$marker" ]; then status=124; fi
rm -f "$marker"
exit "$status"
`,
  );
  chmodSync(awsPath, 0o755);
  chmodSync(timeoutPath, 0o755);

  try {
    const result = spawnSync('bash', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...environment,
        FSK_MOCK_AWS_LOG: callLogPath,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      },
      timeout,
    });
    return {
      ...result,
      awsCalls: existsSync(callLogPath)
        ? readFileSync(callLogPath, 'utf8').trim().split('\n')
        : [],
    };
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
};

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
  it('records a verified Foundation deployment and an approved Migration while keeping the other four write stages pending', () => {
    expect(documentFieldValues(COST_APPROVAL, 'GateStatus')).toEqual([
      'FOUNDATION_DEPLOYED_VERIFIED',
    ]);
    expect(documentFieldValues(COST_APPROVAL, 'LowUseMonthlyJpy')).toContain(
      '约 ¥1,000',
    );
    expect(
      documentFieldValues(COST_APPROVAL, 'OneAcuWorstMonthJpy'),
    ).toContain('约 ¥19,600');

    const stages = markdownRows(COST_APPROVAL).filter(([stage]) =>
      [
        'Foundation',
        'Migration',
        'Full backend',
        'Hosting',
        'Budget/alarms',
        'Destroy',
      ].includes(stage),
    );
    expect(stages).toEqual([
      ['Foundation', 'Auth + Storage + VPC + Aurora/Data API', 'FSK-FOUNDATION-20260823-221547-JST'],
      ['Migration', 'CloudShell VPC + 临时 NAT/IGW/EIP + 临时运维 SG', 'FSK-MIGRATION-20260824-145858-JST'],
      ['Full backend', 'HTTP API + Kitchen/Admin/Export Functions', 'PENDING_USER_APPROVAL'],
      ['Hosting', 'Vue/PWA', 'PENDING_USER_APPROVAL'],
      ['Budget/alarms', 'Budget、费用异常检测、指标和告警', 'PENDING_USER_APPROVAL'],
      ['Destroy', 'App/branch/stacks/保留资源/远程 ref 的逐项销毁', 'PENDING_USER_APPROVAL'],
    ]);
  });

  it('binds the Migration approval to the exact source, operation tuple, network scope, deadlines, and owners', () => {
    expect(
      Object.fromEntries(
        Object.keys(MIGRATION_APPROVAL_EVIDENCE).map((field) => [
          field,
          documentFieldValues(MIGRATION_RUNBOOK, field),
        ]),
      ),
    ).toEqual(MIGRATION_APPROVAL_EVIDENCE);

    expect(documentFieldValues(COST_APPROVAL, 'MigrationApprovalId')).toEqual([
      'FSK-MIGRATION-20260824-145858-JST',
    ]);
    expect(
      documentFieldValues(COST_APPROVAL, 'MigrationUserApprovalStatement'),
    ).toEqual([
      '批准在已部署的 FSK staging Foundation 上创建带 operation token 的临时 CloudShell VPC 出口和运维 5432 访问，执行合成数据库 migration/verify 后立即清理；不导入真实 SQLite、用户、bcrypt hash 或 uploads。',
    ]);
    expect(documentFieldValues(COST_APPROVAL, 'MigrationStatus')).toEqual([
      'NOT_RUN',
    ]);
  });

  it('binds the deployed Foundation to the exact App, source, stacks, and cost controls', () => {
    const expectedEvidence = {
      DeploymentStatus: ['FOUNDATION_DEPLOYED_VERIFIED'],
      DeployedAtUtc: ['2026-08-24 05:44:30 UTC'],
      AmplifyAppId: ['d2ztmb4nlq3clr'],
      AmplifyBranch: ['staging'],
      DeployedCommit: ['dcff57ebc9bc6d77fbb51072b996834f5a5ca715'],
      DeployedTag: ['fsk-staging-data-api-foundation-v1'],
      FoundationStackStatus: ['FskStagingFoundation / CREATE_COMPLETE'],
      AmplifyStackStatus: [
        'amplify-d2ztmb4nlq3clr-staging-branch-08a82c5fa9 / CREATE_COMPLETE',
      ],
      AutoBuild: ['false'],
      InitialHostingJobStatus: ['1 / CANCELLED / commit HEAD'],
      AuroraEngineVersion: ['aurora-postgresql 18.4'],
      AuroraAcuRange: ['0–1 ACU'],
      AuroraAutoPauseSeconds: ['300'],
      AuroraIdleObservedAcu: ['0.0 at 2026-08-24 05:47:00 UTC'],
      PersistentNatGateways: ['0'],
      PersistentInternetGateways: ['0'],
      PersistentInterfaceEndpoints: ['0'],
      DatabaseIngressRuleCount: ['0'],
      HostingStatus: ['NOT_DEPLOYED'],
      MigrationStatus: ['NOT_RUN'],
      FullBackendStatus: ['NOT_DEPLOYED'],
    };

    expect(
      Object.fromEntries(
        Object.keys(expectedEvidence).map((field) => [
          field,
          documentFieldValues(COST_APPROVAL, field),
        ]),
      ),
    ).toEqual(expectedEvidence);
  });

  it('binds every required Foundation approval evidence field exactly', () => {
    const fabricatedApproval = COST_APPROVAL.replace(
      '| ApprovedCommit | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715` |',
      '| ApprovedCommit | `FABRICATED_APPROVAL` |',
    );

    expect(preBindingApprovalEvidence(COST_APPROVAL)).toEqual(
      FOUNDATION_APPROVAL_EVIDENCE,
    );
    expect(preBindingApprovalEvidence(fabricatedApproval)).not.toEqual(
      FOUNDATION_APPROVAL_EVIDENCE,
    );
  });

  it('auto-invalidates approval when the 1 ACU always-on scenario exceeds the ¥5,000 ceiling', () => {
    const conflictingEstimate = COST_APPROVAL.replace(
      '| OneAcuWorstMonthJpy | `约 ¥19,600` |',
      '| OneAcuWorstMonthJpy | `约 ¥19,600` |\n| OneAcuWorstMonthJpy | `约 ¥18,000` |',
    );
    const monthlyCeilings = documentFieldValues(
      COST_APPROVAL,
      'MonthlyCeilingJpy',
    ).map(parseJpyAmount);
    const oneAcuWorstMonths = documentFieldValues(
      COST_APPROVAL,
      'OneAcuWorstMonthJpy',
    );
    const conflictingOneAcuWorstMonths = documentFieldValues(
      conflictingEstimate,
      'OneAcuWorstMonthJpy',
    );
    const [oneAcuWorstMonth] = oneAcuWorstMonths.map(parseJpyAmount);

    expect(monthlyCeilings).toEqual([5_000, 5_000, 5_000]);
    expect(oneAcuWorstMonths).toEqual(['约 ¥19,600']);
    expect(conflictingOneAcuWorstMonths).not.toEqual(['约 ¥19,600']);
    expect(oneAcuWorstMonth).toBe(19_600);
    expect(oneAcuWorstMonth).toBeGreaterThan(Math.max(...monthlyCeilings));
    expect(
      documentFieldValues(COST_APPROVAL, 'OneAcuWorstMonthGateAction'),
    ).toEqual(['AUTO_INVALIDATE_STOP_REVIEW']);
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

  it('binds both cost approval tag fields to the Data API recovery point', () => {
    expect(documentFieldValues(COST_APPROVAL, 'Git deployment point')).toEqual([
      'fsk-staging-data-api-foundation-v1',
    ]);
    expect(documentFieldValues(COST_APPROVAL, 'ApprovedTag')).toEqual([
      'fsk-staging-data-api-foundation-v1',
    ]);
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

  it.each([
    ['deployment approval', DEPLOYMENT_RUNBOOK, 'FSK_APPROVED_TAG'],
    ['deployment foundation', DEPLOYMENT_RUNBOOK, 'FSK_FOUNDATION_TAG'],
    ['migration foundation', MIGRATION_RUNBOOK, 'FSK_FOUNDATION_TAG'],
  ])('defaults %s execution to the Data API recovery tag', (_name, runbook, variable) => {
    const assignment = extractBashDefaultAssignment(runbook, variable);
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
unset ${variable}
${assignment}
printf '%s' "$${variable}"
`,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('fsk-staging-data-api-foundation-v1');
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
    expect(JSON.parse(result.stdout)).toEqual(OWNERSHIP_TAGS);
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

  it('publishes FAILED when READY_FOR_CLEANUP publication fails', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-worker-ready-'));
    const migrateCountPath = join(fixtureDirectory, 'migrate-count');
    const script = `set -euo pipefail
fsk_assert_migration_deadline() { :; }
fsk_build_database_url() { export DATABASE_URL='postgresql://private'; }
fsk_run_before_migration_deadline() { "$@"; }
fsk_publish_worker_status() {
  printf 'STATUS=%s\\n' "$1"
  if [ "$1" = READY_FOR_CLEANUP ]; then return 47; fi
}
pnpm() {
  case "$*" in
    'run db:staging:migrate')
      count=0
      if [ -f "$FSK_MOCK_MIGRATE_COUNT" ]; then count="$(cat "$FSK_MOCK_MIGRATE_COUNT")"; fi
      count=$((count + 1))
      printf '%s' "$count" > "$FSK_MOCK_MIGRATE_COUNT"
      if [ "$count" -eq 1 ]; then
        printf 'MIGRATIONS_APPLIED count=1\\n'
      else
        printf 'MIGRATIONS_APPLIED count=0\\n'
      fi
      ;;
    'run db:staging:verify') printf 'SCHEMA_VERIFIED business_tables=10\\n' ;;
    *) return 91 ;;
  esac
}
FSK_MIGRATION_SHELL_ROLE=worker
FSK_WORKER_READY_FOR_CLEANUP=0
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_worker_exit')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_worker_run_database_migration')}
trap 'fsk_worker_exit "$?"' EXIT
fsk_worker_run_database_migration
`;

    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_MOCK_MIGRATE_COUNT: migrateCountPath,
        },
      });

      expect(result.status).toBe(47);
      expect(result.stdout).toContain('STATUS=READY_FOR_CLEANUP');
      expect(result.stdout).toContain('STATUS=FAILED:WORKER_EXIT_47');
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it.each([
    '00000000-0000-4000-8000-00000000000 ',
    '00000000/0000-4000-8000-000000000000',
    '00000000-0000-4000-8000-00000000000$',
    '00000000-0000-3000-8000-000000000000',
    '00000000-0000-4000-7000-000000000000',
  ])('rejects unsafe or non-v4 operation token %j', (token) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_operation_token')}
fsk_assert_operation_token "$FSK_MIGRATION_OPERATION_TOKEN"
`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FSK_MIGRATION_OPERATION_TOKEN: token },
      },
    );

    expect(result.status).not.toBe(0);
  });

  it('accepts a full hexadecimal UUIDv4 operation token', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_operation_token')}
fsk_assert_operation_token "$FSK_MIGRATION_OPERATION_TOKEN"
`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSK_MIGRATION_OPERATION_TOKEN:
            OWNERSHIP_ENVIRONMENT.FSK_MIGRATION_OPERATION_TOKEN,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('filters EC2 candidates through all eight exact ownership fields', () => {
    const adversarialResources = [
      { GroupId: 'sg-owned', Tags: OWNERSHIP_TAGS },
      ...OWNERSHIP_TAGS.map(({ Key }, index) => ({
        GroupId: `sg-decoy-${index}`,
        Tags: OWNERSHIP_TAGS.map((tag) =>
          tag.Key === Key ? { ...tag, Value: `foreign-${index}` } : tag,
        ),
      })),
    ];
    const script = `set -euo pipefail
fsk_run_current_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_resource_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_operations_sg_ids')}
fsk_discover_owned_operations_sg_ids
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'ec2 describe-security-groups'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_MOCK_RESPONSE: JSON.stringify({
          SecurityGroups: adversarialResources,
        }),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('sg-owned');
  });

  it('filters database ingress by exact ownership and 5432 source-group semantics', () => {
    const ownedRule = {
      SecurityGroupRuleId: 'sgr-owned',
      GroupId: 'sg-database',
      GroupOwnerId: OWNERSHIP_ENVIRONMENT.FSK_AWS_ACCOUNT_ID,
      IsEgress: false,
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      ReferencedGroupInfo: {
        GroupId: 'sg-operations',
        UserId: OWNERSHIP_ENVIRONMENT.FSK_AWS_ACCOUNT_ID,
      },
      Tags: OWNERSHIP_TAGS,
    };
    const semanticDecoys = [
      { GroupId: 'sg-foreign-database' },
      { GroupOwnerId: '111111111111' },
      { IsEgress: true },
      { IpProtocol: 'udp' },
      { FromPort: 5431 },
      { ToPort: 5433 },
      { ReferencedGroupInfo: { ...ownedRule.ReferencedGroupInfo, GroupId: 'sg-foreign' } },
      { ReferencedGroupInfo: { ...ownedRule.ReferencedGroupInfo, UserId: '111111111111' } },
    ].map((override, index) => ({
      ...ownedRule,
      ...override,
      SecurityGroupRuleId: `sgr-decoy-${index}`,
    }));
    const foreignTagRule = {
      ...ownedRule,
      SecurityGroupRuleId: 'sgr-foreign-tag',
      Tags: OWNERSHIP_TAGS.map((tag) =>
        tag.Key === 'ManagedBy' ? { ...tag, Value: 'Foreign' } : tag,
      ),
    };
    const script = `set -euo pipefail
fsk_run_current_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_db_ingress_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_db_ingress_ids')}
fsk_discover_owned_db_ingress_ids
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'ec2 describe-security-group-rules'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_DB_SECURITY_GROUP_ID: 'sg-database',
        FSK_OPS_SG_ID: 'sg-operations',
        FSK_MOCK_RESPONSE: JSON.stringify({
          SecurityGroupRules: [ownedRule, ...semanticDecoys, foreignTagRule],
        }),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('sgr-owned');
  });

  it.each(
    ['ec2 resources', 'ingress rules', 'resource tag mappings', 'ssm parameters']
      .flatMap((parser) => [
        [parser, 'missing collection', {}],
        [parser, 'null collection', null],
        [parser, 'wrong collection type', {}],
        [parser, 'malformed item', [{}]],
      ]) as [string, string, unknown][],
  )('fails closed for %s with a %s response', (parser, shape, collection) => {
    const collectionName =
      parser === 'ec2 resources'
        ? 'SecurityGroups'
        : parser === 'ingress rules'
          ? 'SecurityGroupRules'
          : parser === 'resource tag mappings'
            ? 'ResourceTagMappingList'
            : 'Parameters';
    const response =
      shape === 'missing collection'
        ? {}
        : {
            [collectionName]:
              shape === 'wrong collection type' ? { invalid: true } : collection,
          };
    const commonFunctions = `
fsk_run_current_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
`;
    let script: string;
    let mockAwsBody: string;
    if (parser === 'ec2 resources') {
      script = `set -euo pipefail
${commonFunctions}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_resource_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_operations_sg_ids')}
fsk_discover_owned_operations_sg_ids
`;
      mockAwsBody = `case "$*" in
  *'ec2 describe-security-groups'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`;
    } else if (parser === 'ingress rules') {
      script = `set -euo pipefail
${commonFunctions}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_db_ingress_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_db_ingress_ids')}
fsk_discover_owned_db_ingress_ids
`;
      mockAwsBody = `case "$*" in
  *'ec2 describe-security-group-rules'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`;
    } else {
      script = `set -euo pipefail
${commonFunctions}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_no_task_id_collision')}
fsk_assert_no_task_id_collision
`;
      mockAwsBody = `case "$*" in
  *'resourcegroupstaggingapi get-resources'*)
    if [ "$FSK_MOCK_PARSER" = 'resource tag mappings' ]; then
      printf '%s' "$FSK_MOCK_RESPONSE"
    else
      printf '{"ResourceTagMappingList":[]}'
    fi
    ;;
  *'ssm describe-parameters'*)
    if [ "$FSK_MOCK_PARSER" = 'ssm parameters' ]; then
      printf '%s' "$FSK_MOCK_RESPONSE"
    else
      printf '{"Parameters":[]}'
    fi
    ;;
  *) exit 64 ;;
esac`;
    }
    const result = runWithMockAws(script, mockAwsBody, {
      ...OWNERSHIP_ENVIRONMENT,
      FSK_DB_SECURITY_GROUP_ID: 'sg-database',
      FSK_OPS_SG_ID: 'sg-operations',
      FSK_MOCK_PARSER: parser,
      FSK_MOCK_RESPONSE: JSON.stringify(response),
    });

    expect(result.status).not.toBe(0);
  });

  it('blocks a TaskId-wide collision owned by another operation token', () => {
    const collisionTags = OWNERSHIP_TAGS.map((tag) =>
      tag.Key === 'OperationToken'
        ? { ...tag, Value: '11111111-1111-4111-8111-111111111111' }
        : tag,
    );
    const script = `set -euo pipefail
fsk_run_current_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_no_task_id_collision')}
fsk_assert_no_task_id_collision
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'resourcegroupstaggingapi get-resources'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *'ssm describe-parameters'*) printf '{"Parameters":[]}' ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_MOCK_RESPONSE: JSON.stringify({
          ResourceTagMappingList: [
            { ResourceARN: 'arn:aws:ec2:test:foreign', Tags: collisionTags },
          ],
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TASK_ID_OWNERSHIP_COLLISION_STOP');
  });

  it('propagates a malformed TaskId state-discovery response', () => {
    const script = `set -euo pipefail
fsk_run_current_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_no_task_id_collision')}
fsk_assert_no_task_id_collision
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'resourcegroupstaggingapi get-resources'*) printf '{"ResourceTagMappingList":[]}' ;;
  *'ssm describe-parameters'*) printf 'not-json' ;;
  *) exit 64 ;;
esac`,
      OWNERSHIP_ENVIRONMENT,
    );

    expect(result.status).not.toBe(0);
  });

  it.each([
    ['nonzero response loss', 'nonzero', 0],
    ['exit-zero empty output', 'empty', 0],
    ['exit-zero None output', 'none', 0],
    ['multiple owned matches', 'multiple', 1],
    ['foreign-tag decoy', 'foreign-decoy', 0],
    ['foreign-only match', 'foreign-only', 1],
  ])('recovers operations SG safely after %s', (_name, mode, shouldFail) => {
    const owned = { GroupId: 'sg-owned', Tags: OWNERSHIP_TAGS };
    const foreign = {
      GroupId: 'sg-foreign',
      Tags: OWNERSHIP_TAGS.map((tag) =>
        tag.Key === 'CostCenter' ? { ...tag, Value: 'FOREIGN' } : tag,
      ),
    };
    const resources =
      mode === 'multiple'
        ? [owned, { ...owned, GroupId: 'sg-owned-2' }]
        : mode === 'foreign-only'
          ? [foreign]
          : mode === 'foreign-decoy'
            ? [foreign, owned]
            : [owned];
    const script = `set -euo pipefail
fsk_run_before_migration_deadline() { "$@"; }
fsk_run_current_deadline() { "$@"; }
FSK_TEMP_EC2_TAGS='[]'
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_require_single_owned_id')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_resource_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_operations_sg_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_create_or_recover_owned_id')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_create_or_recover_operations_sg')}
fsk_create_or_recover_operations_sg
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'ec2 create-security-group'*)
    case "$FSK_MOCK_CREATE_MODE" in
      nonzero) exit 55 ;;
      empty) exit 0 ;;
      none) printf 'None\\n' ;;
    esac
    ;;
  *'ec2 describe-security-groups'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_MOCK_CREATE_MODE: mode,
        FSK_MOCK_RESPONSE: JSON.stringify({ SecurityGroups: resources }),
      },
    );

    if (shouldFail) {
      expect(result.status).not.toBe(0);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('sg-owned');
    }
    expect(
      result.awsCalls.some((call) =>
        call.includes('ec2 describe-security-groups'),
      ),
    ).toBe(true);
  });

  it.each([
    [
      'accepts exactly both Foundation VPC route tables without default routes',
      {
        RouteTables: [
          {
            RouteTableId: 'rtb-a',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [],
          },
          {
            RouteTableId: 'rtb-b',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [],
          },
        ],
      },
      0,
    ],
    [
      'rejects a missing requested route table',
      {
        RouteTables: [
          {
            RouteTableId: 'rtb-a',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [],
          },
        ],
      },
      1,
    ],
    [
      'rejects a requested route table from a foreign VPC',
      {
        RouteTables: [
          {
            RouteTableId: 'rtb-a',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [],
          },
          {
            RouteTableId: 'rtb-b',
            VpcId: 'vpc-foreign',
            Routes: [],
          },
        ],
      },
      1,
    ],
    [
      'rejects an existing default route',
      {
        RouteTables: [
          {
            RouteTableId: 'rtb-a',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [],
          },
          {
            RouteTableId: 'rtb-b',
            VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
            Routes: [
              {
                DestinationCidrBlock: '0.0.0.0/0',
                NatGatewayId: 'nat-existing',
              },
            ],
          },
        ],
      },
      1,
    ],
  ])('%s', (_name, response, shouldFail) => {
    const script = `set -euo pipefail
fsk_assert_migration_deadline() { :; }
fsk_run_before_migration_deadline() { "$@"; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_application_route_tables_ready')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_control_guard')}
fsk_assert_control_guard
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'ec2 describe-route-tables'*) printf '%s' "$FSK_MOCK_RESPONSE" ;;
  *) exit 64 ;;
esac`,
      {
        FSK_APP_ROUTE_TABLE_A_ID: 'rtb-a',
        FSK_APP_ROUTE_TABLE_B_ID: 'rtb-b',
        FSK_MIGRATION_SHELL_ROLE: 'control',
        FSK_VPC_ID: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
        FSK_MOCK_RESPONSE: JSON.stringify(response),
      },
    );

    if (shouldFail) {
      expect(result.status).not.toBe(0);
    } else {
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('preserves a foreign default route when the pre-create guard fails', () => {
    const script = `set -euo pipefail
fsk_run_current_deadline() { "$@"; }
fsk_run_before_cleanup_deadline() { "$@"; }
fsk_assert_control_guard() { return 88; }
fsk_publish_control_status() { return 1; }
fsk_finalize_cleanup_state() { printf 'UNEXPECTED_FINALIZE\\n' >&2; return 90; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_resource_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_require_single_owned_id')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_nat_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_describe_default_route_target')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_owned_application_routes')}
fsk_control_cleanup_owned_resources() { fsk_delete_owned_application_routes; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_exit')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_run_migration')}
fsk_control_run_migration
`;
    const result = runWithMockAws(
      script,
      `case "$*" in
  *'ec2 describe-nat-gateways'*) printf '%s' "$FSK_MOCK_NAT_RESPONSE" ;;
  *'ec2 describe-route-tables'*) printf '%s' "$FSK_MOCK_ROUTE_RESPONSE" ;;
  *'ec2 delete-route'*) exit 90 ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_APP_ROUTE_TABLE_A_ID: 'rtb-a',
        FSK_APP_ROUTE_TABLE_B_ID: 'rtb-b',
        FSK_MOCK_NAT_RESPONSE: JSON.stringify({
          NatGateways: [{ NatGatewayId: 'nat-owned', Tags: OWNERSHIP_TAGS }],
        }),
        FSK_MOCK_ROUTE_RESPONSE: JSON.stringify({
          RouteTables: [
            {
              RouteTableId: 'rtb-a',
              VpcId: OWNERSHIP_ENVIRONMENT.FSK_VPC_ID,
              Routes: [
                {
                  DestinationCidrBlock: '0.0.0.0/0',
                  NatGatewayId: 'nat-foreign',
                },
              ],
            },
          ],
        }),
      },
    );

    expect(result.status).toBe(88);
    expect(result.stderr).toContain('FOREIGN_DEFAULT_ROUTE_BLOCKED');
    expect(result.stderr).toContain('CLEANUP_BLOCKED:EXIT_88');
    expect(result.stderr).not.toContain('UNEXPECTED_FINALIZE');
    expect(result.awsCalls.some((call) => call.includes('delete-route'))).toBe(
      false,
    );
  });

  it('terminates a hung cleanup AWS call at the approved cleanup deadline', () => {
    const script = `set -euo pipefail
FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH=$(($(date +%s) + 1))
FSK_CLEANUP_COMMAND_MAX_SECONDS=30
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_seconds_before_cleanup_deadline')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_run_before_cleanup_deadline')}
fsk_run_before_cleanup_deadline aws ec2 describe-nat-gateways
`;
    const startedAt = Date.now();
    const result = runWithMockAws(script, 'exec sleep 5', {}, 4_000);
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(124);
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it('waits for the exact owned NAT to reach deleted before releasing its EIP', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-nat-delete-'));
    const pollCountPath = join(fixtureDirectory, 'poll-count');
    const script = `set -euo pipefail
fsk_delete_owned_application_routes() { :; }
fsk_discover_owned_db_ingress_ids() { :; }
fsk_discover_owned_nat_ids() { printf 'nat-owned\\n'; }
fsk_discover_owned_eip_ids() { printf 'eipalloc-owned\\n'; }
fsk_discover_owned_route_table_ids() { :; }
fsk_discover_owned_public_subnet_ids() { :; }
fsk_discover_owned_igw_ids() { :; }
fsk_discover_owned_operations_sg_ids() { :; }
fsk_run_before_cleanup_deadline() { "$@"; }
fsk_sleep_before_cleanup_deadline() { :; }
FSK_CLEANUP_POLL_SECONDS=0
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_wait_for_owned_nat_deleted')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_owned_temporary_resources_once')}
fsk_delete_owned_temporary_resources_once
`;

    try {
      const result = runWithMockAws(
        script,
        `case " $* " in
  *' ec2 delete-nat-gateway '*) exit 0 ;;
  *' ec2 describe-nat-gateways '*)
    count=0
    if [ -f "$FSK_MOCK_POLL_COUNT" ]; then count="$(cat "$FSK_MOCK_POLL_COUNT")"; fi
    count=$((count + 1))
    printf '%s' "$count" > "$FSK_MOCK_POLL_COUNT"
    state=deleting
    if [ "$count" -ge 2 ]; then state=deleted; fi
    printf '{"NatGateways":[{"NatGatewayId":"nat-owned","State":"%s","Tags":%s}]}' \
      "$state" "$FSK_MOCK_TAGS"
    ;;
  *' ec2 release-address '*) exit 0 ;;
  *) exit 64 ;;
esac`,
        {
          ...OWNERSHIP_ENVIRONMENT,
          FSK_MOCK_POLL_COUNT: pollCountPath,
          FSK_MOCK_TAGS: JSON.stringify(OWNERSHIP_TAGS),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(
        result.awsCalls.filter(
          (call) =>
            call.includes('delete-nat-gateway') ||
            call.includes('describe-nat-gateways') ||
            call.includes('release-address'),
        ),
      ).toEqual([
        'ec2 delete-nat-gateway --region ap-northeast-1 --nat-gateway-id nat-owned',
        'ec2 describe-nat-gateways --region ap-northeast-1 --nat-gateway-ids nat-owned --output json',
        'ec2 describe-nat-gateways --region ap-northeast-1 --nat-gateway-ids nat-owned --output json',
        'ec2 release-address --region ap-northeast-1 --allocation-id eipalloc-owned',
      ]);
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it.each([
    ['deadline timeout', 'timeout'],
    ['describe failure', 'failure'],
  ])('does not release the EIP when NAT deletion polling has a %s', (_name, mode) => {
    const script = `set -euo pipefail
fsk_delete_owned_application_routes() { :; }
fsk_discover_owned_db_ingress_ids() { :; }
fsk_discover_owned_nat_ids() { printf 'nat-owned\\n'; }
fsk_discover_owned_eip_ids() { printf 'eipalloc-owned\\n'; }
fsk_discover_owned_route_table_ids() { :; }
fsk_discover_owned_public_subnet_ids() { :; }
fsk_discover_owned_igw_ids() { :; }
fsk_discover_owned_operations_sg_ids() { :; }
fsk_run_before_cleanup_deadline() {
  if [ "$FSK_MOCK_POLL_MODE" = timeout ] && [[ " $* " == *' ec2 describe-nat-gateways '* ]]; then
    return 124
  fi
  "$@"
}
fsk_sleep_before_cleanup_deadline() { :; }
FSK_CLEANUP_POLL_SECONDS=0
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_wait_for_owned_nat_deleted')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_owned_temporary_resources_once')}
fsk_delete_owned_temporary_resources_once
`;
    const result = runWithMockAws(
      script,
      `case " $* " in
  *' ec2 delete-nat-gateway '*) exit 0 ;;
  *' ec2 describe-nat-gateways '*) exit 47 ;;
  *' ec2 release-address '*) exit 90 ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_MOCK_POLL_MODE: mode,
      },
    );

    expect(result.status).not.toBe(0);
    expect(
      result.awsCalls.some((call) => call.includes('release-address')),
    ).toBe(false);
  });

  it('keeps a one-time real cleanup mutation failure terminally blocked', () => {
    const script = `set -euo pipefail
FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH=$(($(date +%s) + 20))
FSK_CLEANUP_COMMAND_MAX_SECONDS=5
FSK_STABLE_ZERO_REQUIRED=1
FSK_STABLE_ZERO_MIN_SECONDS=0
FSK_CLEANUP_POLL_SECONDS=0
fsk_load_cleanup_failure_latch() { printf '0'; }
fsk_record_cleanup_failure_latch() { :; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_seconds_before_cleanup_deadline')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_run_before_cleanup_deadline')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_sleep_before_cleanup_deadline')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_run_current_deadline')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_require_single_owned_id')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_resource_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_operations_sg_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_igw_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_public_subnet_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_route_table_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_eip_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_nat_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_select_exact_owned_db_ingress_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_db_ingress_ids')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_discover_owned_residual_count')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_describe_default_route_target')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_owned_application_routes')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_count_owned_application_route_residuals')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_owned_temporary_resources_once')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_cleanup_owned_resources')}
fsk_control_cleanup_owned_resources
`;
    const result = runWithMockAws(
      script,
      `case " $* " in
  *' ec2 describe-route-tables '*--route-table-ids*)
    route_table_id=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = --route-table-ids ]; then route_table_id="$argument"; fi
      previous="$argument"
    done
    printf '{"RouteTables":[{"RouteTableId":"%s","VpcId":"%s","Routes":[]}]}' \
      "$route_table_id" "$FSK_VPC_ID"
    ;;
  *' ec2 describe-route-tables '*) printf '{"RouteTables":[]}' ;;
  *' ec2 describe-security-group-rules '*) printf '{"SecurityGroupRules":[]}' ;;
  *' ec2 describe-nat-gateways '*) printf '{"NatGateways":[]}' ;;
  *' ec2 describe-addresses '*) printf '{"Addresses":[]}' ;;
  *' ec2 describe-subnets '*) printf '{"Subnets":[]}' ;;
  *' ec2 describe-internet-gateways '*) printf '{"InternetGateways":[]}' ;;
  *' ec2 describe-security-groups '*)
    if [ -f "$FSK_MOCK_AWS_LOG.deleted" ]; then
      printf '{"SecurityGroups":[]}'
    else
      printf '%s' "$FSK_MOCK_OWNED_SG_RESPONSE"
    fi
    ;;
  *' ec2 delete-security-group '*)
    if [ ! -f "$FSK_MOCK_AWS_LOG.failed" ]; then
      touch "$FSK_MOCK_AWS_LOG.failed"
      exit 47
    fi
    touch "$FSK_MOCK_AWS_LOG.deleted"
    ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_APP_ROUTE_TABLE_A_ID: 'rtb-a',
        FSK_APP_ROUTE_TABLE_B_ID: 'rtb-b',
        FSK_DB_SECURITY_GROUP_ID: 'sg-database',
        FSK_OPS_SG_ID: 'sg-operations',
        FSK_MOCK_OWNED_SG_RESPONSE: JSON.stringify({
          SecurityGroups: [
            { GroupId: 'sg-operations', Tags: OWNERSHIP_TAGS },
          ],
        }),
      },
      15_000,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('STABLE_ZERO_OBSERVATIONS');
    expect(result.stderr).toContain('CLEANUP_MUTATION_FAILED_BLOCKED');
    expect(
      result.awsCalls.filter((call) => call.includes('delete-security-group')),
    ).toHaveLength(2);
  });

  it('reloads a persisted cleanup failure latch after CleanupOwner restart', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'fsk-cleanup-latch-'));
    const statePath = join(fixtureDirectory, 'state.json');
    const failedOncePath = join(fixtureDirectory, 'failed-once');
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, sensitive: false, cleanupFailed: false }),
    );
    const script = `set -euo pipefail
FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH=$(($(date +%s) + 20))
FSK_STABLE_ZERO_REQUIRED=1
FSK_STABLE_ZERO_MIN_SECONDS=0
FSK_CLEANUP_POLL_SECONDS=0
fsk_assert_state_parameter_owned() { :; }
fsk_run_current_deadline() { "$@"; }
fsk_sleep_before_cleanup_deadline() { :; }
fsk_delete_owned_temporary_resources_once() {
  if [ ! -f "$FSK_MOCK_DELETE_FAILED_ONCE" ]; then
    touch "$FSK_MOCK_DELETE_FAILED_ONCE"
    return 47
  fi
}
fsk_discover_owned_residual_count() { printf '0\\n'; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_load_cleanup_failure_latch')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_record_cleanup_failure_latch')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_control_cleanup_owned_resources')}
fsk_control_cleanup_owned_resources
`;
    const mockAwsBody = `case " $* " in
  *' ssm get-parameter '*) cat "$FSK_MOCK_STATE_PATH" ;;
  *' ssm put-parameter '*)
    previous=''
    for argument in "$@"; do
      if [ "$previous" = --value ]; then printf '%s' "$argument" > "$FSK_MOCK_STATE_PATH"; fi
      previous="$argument"
    done
    printf '2\\n'
    ;;
  *) exit 64 ;;
esac`;
    const environment = {
      ...OWNERSHIP_ENVIRONMENT,
      FSK_STATE_PARAMETER: '/fsk/test/state',
      FSK_MOCK_DELETE_FAILED_ONCE: failedOncePath,
      FSK_MOCK_STATE_PATH: statePath,
    };

    try {
      const firstOwner = runWithMockAws(
        script,
        mockAwsBody,
        environment,
      );
      expect(firstOwner.status).not.toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cleanupFailed: true,
      });

      const restartedOwner = runWithMockAws(
        script,
        mockAwsBody,
        environment,
      );
      expect(restartedOwner.status).not.toBe(0);
      expect(restartedOwner.stderr).toContain(
        'CLEANUP_PREVIOUS_FAILURE_BLOCKED',
      );
      expect(restartedOwner.stdout).not.toContain('STABLE_ZERO_OBSERVATIONS');
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
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
fsk_sleep_before_cleanup_deadline() { :; }
fsk_load_cleanup_failure_latch() { printf '0'; }
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

  it('keeps control status available when nonterminal state deletion fails', () => {
    const script = `set -euo pipefail
fsk_run_before_cleanup_deadline() { "$@"; }
fsk_run_current_deadline() { fsk_run_before_cleanup_deadline "$@"; }
fsk_discover_owned_residual_count() { printf '0\\n'; }
fsk_load_cleanup_failure_latch() { printf '0'; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_snapshot_state_parameter')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_state_parameter_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_publish_control_status')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_state_parameter_if_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_nonterminal_state_parameters')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_count_state_parameter_path_residuals')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_emit_terminal_cleanup_evidence')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_finalize_cleanup_state')}
fsk_finalize_cleanup_state 73
`;
    const result = runWithMockAws(
      script,
      `case " $* " in
  *' ssm get-parameter '*)
    name=""; previous=""
    for argument in "$@"; do
      if [ "$previous" = --name ]; then name="$argument"; fi
      previous="$argument"
    done
    printf '{"Parameter":{"Name":"%s","Type":"String","Version":1}}' "$name"
    ;;
  *' ssm list-tags-for-resource '*)
    printf '%s' "$FSK_MOCK_TAG_RESPONSE"
    ;;
  *' ssm put-parameter '*) printf '2\\n' ;;
  *' ssm delete-parameter '*)
    case "$*" in
      *worker-status*) exit 0 ;;
      *'/state'*) exit 47 ;;
      *control-status*) exit 0 ;;
    esac
    ;;
  *' ssm describe-parameters '*)
    case "$*" in
      *worker-status*) printf '0\\n' ;;
      *'/state'*) printf '1\\n' ;;
      *control-status*) printf '1\\n' ;;
      *) printf '2\\n' ;;
    esac
    ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_WORKER_STATUS_PARAMETER: '/fsk/test/worker-status',
        FSK_STATE_PARAMETER: '/fsk/test/state',
        FSK_CONTROL_STATUS_PARAMETER: '/fsk/test/control-status',
        FSK_STATE_PREFIX: '/fsk/test',
        FSK_MOCK_TAG_RESPONSE: JSON.stringify({ TagList: OWNERSHIP_TAGS }),
      },
    );

    expect(result.status).not.toBe(0);
    const log = result.awsCalls.join('\n');
    expect(log).toContain('CLEANUP_RESOURCES_STABLE_ZERO');
    expect(log).toContain('delete-parameter --region ap-northeast-1 --name /fsk/test/worker-status');
    expect(log).toContain('delete-parameter --region ap-northeast-1 --name /fsk/test/state');
    expect(log).toContain('CLEANUP_BLOCKED');
    expect(log).not.toContain('CLEANUP_PASS');
    expect(log).not.toContain('delete-parameter --region ap-northeast-1 --name /fsk/test/control-status');
  });

  it('keeps control status BLOCKED-capable when the final path query fails', () => {
    const statePrefix = '/fsk/test-final-query';
    const workerStatus = `${statePrefix}/worker-status`;
    const state = `${statePrefix}/state`;
    const controlStatus = `${statePrefix}/control-status`;
    const script = `set -euo pipefail
fsk_run_before_cleanup_deadline() { "$@"; }
fsk_run_current_deadline() { fsk_run_before_cleanup_deadline "$@"; }
fsk_assert_no_task_id_collision() { :; }
fsk_discover_owned_residual_count() { printf '0\\n'; }
fsk_load_cleanup_failure_latch() { printf '0'; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_snapshot_state_parameter')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_state_parameter_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_publish_control_status')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_state_parameter_if_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_nonterminal_state_parameters')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_count_state_parameter_path_residuals')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_emit_terminal_cleanup_evidence')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_finalize_cleanup_state')}
fsk_finalize_cleanup_state 0
`;
    const result = runWithMockAws(
      script,
      `parameter_name() {
  local previous='' argument
  for argument in "$@"; do
    if [ "$previous" = --name ] || [ "$previous" = --resource-id ]; then
      printf '%s' "$argument"
      return
    fi
    previous="$argument"
  done
}
case " $* " in
  *' ssm get-parameter '*)
    name="$(parameter_name "$@")"
    printf '{"Parameter":{"Name":"%s","Type":"String","Version":1}}' "$name"
    ;;
  *' ssm list-tags-for-resource '*) printf '%s' "$FSK_MOCK_TAG_RESPONSE" ;;
  *' ssm put-parameter '*) printf '2\\n' ;;
  *' ssm delete-parameter '*)
    case "$*" in
      *control-status*) exit 90 ;;
      *) exit 0 ;;
    esac
    ;;
  *' ssm describe-parameters '*)
    if [[ " $* " == *'Option=BeginsWith'* ]]; then
      exit 47
    fi
    name=''
    for argument in "$@"; do
      case "$argument" in
        Key=Name,Option=Equals,Values=*)
          name="$(printf '%s' "$argument" | cut -d= -f4-)"
          ;;
      esac
    done
    if grep -Fq -- "delete-parameter --region ap-northeast-1 --name $name" "$FSK_MOCK_AWS_LOG"; then
      printf '0\\n'
    else
      printf '1\\n'
    fi
    ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_WORKER_STATUS_PARAMETER: workerStatus,
        FSK_STATE_PARAMETER: state,
        FSK_CONTROL_STATUS_PARAMETER: controlStatus,
        FSK_STATE_PREFIX: statePrefix,
        FSK_MOCK_TAG_RESPONSE: JSON.stringify({ TagList: OWNERSHIP_TAGS }),
      },
    );

    expect(result.status).not.toBe(0);
    const log = result.awsCalls.join('\n');
    const deleteCall = 'delete-parameter --region ap-northeast-1 --name';
    expect(log).toContain(`${deleteCall} ${workerStatus}`);
    expect(log).toContain(`${deleteCall} ${state}`);
    expect(log).toContain('CLEANUP_BLOCKED:STATE_FINAL_QUERY:EXIT_0');
    expect(log).not.toContain('CLEANUP_PASS');
    expect(log).not.toContain(`${deleteCall} ${controlStatus}`);
  });

  it('checks the full TaskId residual set and deletes control status last', () => {
    const statePrefix =
      '/fsk/staging/migration/task-1/00000000-0000-4000-8000-000000000000';
    const workerStatus = `${statePrefix}/worker-status`;
    const state = `${statePrefix}/state`;
    const controlStatus = `${statePrefix}/control-status`;
    const script = `set -euo pipefail
fsk_run_before_cleanup_deadline() { "$@"; }
fsk_run_current_deadline() { fsk_run_before_cleanup_deadline "$@"; }
fsk_discover_owned_residual_count() { printf '0\\n'; }
fsk_load_cleanup_failure_latch() { printf '0'; }
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_exact_ownership_tags')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_no_task_id_collision')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_snapshot_state_parameter')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_assert_state_parameter_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_publish_control_status')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_state_parameter_if_owned')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_delete_nonterminal_state_parameters')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_count_state_parameter_path_residuals')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_emit_terminal_cleanup_evidence')}
${extractBashFunction(MIGRATION_RUNBOOK, 'fsk_finalize_cleanup_state')}
fsk_finalize_cleanup_state 0
`;
    const result = runWithMockAws(
      script,
      `parameter_name() {
  local previous='' argument
  for argument in "$@"; do
    if [ "$previous" = --name ] || [ "$previous" = --resource-id ]; then
      printf '%s' "$argument"
      return
    fi
    previous="$argument"
  done
}
case " $* " in
  *' resourcegroupstaggingapi get-resources '*)
    printf '{"ResourceTagMappingList":[]}'
    ;;
  *' ssm get-parameter '*)
    name="$(parameter_name "$@")"
    printf '{"Parameter":{"Name":"%s","Type":"String","Version":1}}' "$name"
    ;;
  *' ssm list-tags-for-resource '*)
    if [[ " $* " == *' --query TagList '* ]]; then
      printf '%s' "$FSK_MOCK_TAG_LIST"
    else
      printf '%s' "$FSK_MOCK_TAG_RESPONSE"
    fi
    ;;
  *' ssm put-parameter '*) printf '2\\n' ;;
  *' ssm delete-parameter '*) exit 0 ;;
  *' ssm describe-parameters '*)
    if [[ " $* " == *' --output json '* ]]; then
      if grep -Fq -- "delete-parameter --region ap-northeast-1 --name $FSK_CONTROL_STATUS_PARAMETER" "$FSK_MOCK_AWS_LOG"; then
        printf '{"Parameters":[]}'
      else
        printf '{"Parameters":[{"Name":"%s"}]}' "$FSK_CONTROL_STATUS_PARAMETER"
      fi
    elif [[ " $* " == *'Option=BeginsWith'* ]] && \
      [[ " $* " == *"Values=$FSK_STATE_PREFIX/"* ]]; then
      if grep -Fq -- "delete-parameter --region ap-northeast-1 --name $FSK_CONTROL_STATUS_PARAMETER" "$FSK_MOCK_AWS_LOG"; then
        printf '0\\n'
      else
        printf '1\\n'
      fi
    else
      name=''
      for argument in "$@"; do
        case "$argument" in
          Key=Name,Option=Equals,Values=*)
            name="$(printf '%s' "$argument" | cut -d= -f4-)"
            ;;
        esac
      done
      if grep -Fq -- "delete-parameter --region ap-northeast-1 --name $name" "$FSK_MOCK_AWS_LOG"; then
        printf '0\\n'
      else
        printf '1\\n'
      fi
    fi
    ;;
  *) exit 64 ;;
esac`,
      {
        ...OWNERSHIP_ENVIRONMENT,
        FSK_WORKER_STATUS_PARAMETER: workerStatus,
        FSK_STATE_PARAMETER: state,
        FSK_CONTROL_STATUS_PARAMETER: controlStatus,
        FSK_STATE_PREFIX: statePrefix,
        FSK_MOCK_TAG_RESPONSE: JSON.stringify({ TagList: OWNERSHIP_TAGS }),
        FSK_MOCK_TAG_LIST: JSON.stringify(OWNERSHIP_TAGS),
      },
    );

    expect(
      result.status,
      `${result.stderr}\n${result.stdout}\n${result.awsCalls.join('\n')}`,
    ).toBe(0);
    const log = result.awsCalls.join('\n');
    const deleteCall = 'delete-parameter --region ap-northeast-1 --name';
    expect(log).toContain('resourcegroupstaggingapi get-resources');
    expect(log.indexOf(`${deleteCall} ${workerStatus}`)).toBeLessThan(
      log.indexOf(`${deleteCall} ${controlStatus}`),
    );
    expect(log.indexOf(`${deleteCall} ${state}`)).toBeLessThan(
      log.indexOf(`${deleteCall} ${controlStatus}`),
    );
    expect(log).toContain('CLEANUP_FINAL_CHECKS_PASS_CONTROL_DELETE_PENDING');
    expect(log).not.toContain('CLEANUP_PASS');
    expect(result.stdout).toContain('FSK_MIGRATION_TERMINAL_CLEANUP_EVIDENCE');
    expect(result.stdout).toContain('CLEANUP_PASS:EXIT_0');
    expect(result.stdout).toContain('FINAL_PARAMETER_PATH_RESIDUAL_COUNT=0');
    expect(`${result.stdout}${result.stderr}`).not.toContain('CLEANUP_BLOCKED');
  });
});
