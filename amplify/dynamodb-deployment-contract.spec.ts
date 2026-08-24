import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface BuildSpec {
  version: number;
  backend: { phases: { build: { commands: string[] } } };
  frontend: {
    phases: { build: { commands: string[] } };
    artifacts: { baseDirectory: string; files: string[] };
  };
}

interface HeaderRule {
  pattern: string;
  headers: Array<{ key: string; value: string }>;
}

interface HttpConfig {
  customHeaders: HeaderRule[];
}

interface RewriteRule {
  source: string;
  target: string;
  status: string;
}

const repoRoot = process.cwd();
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const parseJsonYaml = <T>(path: string): T => JSON.parse(read(path)) as T;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const extractFences = (document: string, language: string): string[] =>
  [
    ...document.matchAll(
      new RegExp(`^${'```'}${language}\\n([\\s\\S]*?)^${'```'}$`, 'gm'),
    ),
  ].map((match) => match[1]);

function executableShell(block: string): string {
  const executable: string[] = [];
  let heredocEnd: string | undefined;
  for (const line of block.split('\n')) {
    if (heredocEnd) {
      if (line === heredocEnd) heredocEnd = undefined;
      continue;
    }
    const heredoc = line.match(/<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    executable.push(heredoc ? line.slice(0, heredoc.index) : line);
    heredocEnd = heredoc?.[1];
  }
  return executable.join('\n');
}

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
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));

const fields = (document: string): Map<string, string> =>
  new Map(markdownRows(document).map(([name, value]) => [name, value]));

function globMatches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function headersFor(config: HttpConfig, path: string): Record<string, string> {
  return Object.fromEntries(
    config.customHeaders
      .filter((rule) => globMatches(rule.pattern, path))
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key.toLowerCase(), value])),
  );
}

function compileAmplifySource(source: string): RegExp {
  const match = source.match(/^<\/(.*)\/>$/);
  if (!match) throw new Error(`INVALID_AMPLIFY_REGEX:${source}`);
  return new RegExp(match[1]);
}

function resolveHostingPath(path: string, rules: RewriteRule[]): string {
  const rule = rules.find(({ source }) => compileAmplifySource(source).test(path));
  return rule?.status === '200' ? rule.target : path;
}

function createMigrationCliFixture(): {
  root: string;
  sqlitePath: string;
  uploadsPath: string;
  outputPath: string;
  targetConfigPath: string;
} {
  const root = temporaryRoot('fsk-task12-migration-');
  const sqlitePath = join(root, 'source.sqlite');
  const uploadsPath = join(root, 'uploads');
  const outputPath = join(root, 'output');
  const targetConfigPath = join(root, 'invalid-target.json');
  mkdirSync(uploadsPath);
  writeFileSync(targetConfigPath, '{}\n');
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY, "username" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );
    CREATE TABLE "Shift" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "ResponsiblePerson" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "AppSettings" (
      "id" TEXT PRIMARY KEY, "registerFloatAmount" INTEGER NOT NULL,
      "setupCompleted" BOOLEAN NOT NULL
    );
    CREATE TABLE "DailyReport" (
      "id" TEXT PRIMARY KEY, "reportDate" TEXT NOT NULL,
      "shiftId" TEXT NOT NULL, "shiftNameSnapshot" TEXT NOT NULL,
      "responsiblePersonId" TEXT NOT NULL,
      "responsiblePersonSnapshot" TEXT NOT NULL,
      "startMinuteOfDay" INTEGER NOT NULL, "endMinuteOfDay" INTEGER NOT NULL,
      "timeRangeLabelSnapshot" TEXT NOT NULL,
      "previousImosBalanceYen" INTEGER NOT NULL,
      "currentImosBalanceYen" INTEGER NOT NULL,
      "imosSalesYen" INTEGER NOT NULL, "newageYen" INTEGER NOT NULL,
      "cashTotalYen" INTEGER NOT NULL, "expenseYen" INTEGER NOT NULL,
      "expenseReason" TEXT, "staffMealCashYen" INTEGER NOT NULL,
      "staffMealAlipayYen" INTEGER NOT NULL,
      "totalSalesYen" INTEGER NOT NULL, "cashDepositYen" INTEGER NOT NULL,
      "deviationYen" INTEGER NOT NULL, "status" TEXT NOT NULL,
      "createdByUserId" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL
    );
    INSERT INTO "AppSettings" VALUES ('default', 0, 1);
  `);
  database.close();
  return { root, sqlitePath, uploadsPath, outputPath, targetConfigPath };
}

function migrationCommandLines(): Record<'dryRun' | 'import' | 'verify', string> {
  const bash = extractFences(
    read('docs/aws/dynamodb-cutover-runbook.md'),
    'bash',
  ).join('\n');
  const line = (script: string): string => {
    const match = bash.split('\n').find((value) =>
      value.startsWith(`pnpm run ${script} `),
    );
    if (!match) throw new Error(`MIGRATION_COMMAND_NOT_FOUND:${script}`);
    return match;
  };
  return {
    dryRun: line('migration:dry-run'),
    import: line('migration:import'),
    verify: line('migration:verify'),
  };
}

function createFakeCommandBin(root: string): { bin: string; log: string } {
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  executable(join(bin, 'aws'), `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [ "\${1:-}" = sts ]; then printf '%s\\n' "$FSK_EXPECTED_AWS_ACCOUNT_ID"; exit 0; fi
shift
operation="\${1:-}"
case "$operation" in
  get-app)
    if [[ " $* " == *" --query app.name "* ]]; then printf 'FSK\\n'; exit 0; fi
    rules='[{"source":"</^[^.]+$/>","target":"/index.html","status":"200"}]'
    if [ "\${FAKE_UNKNOWN_RULES:-0}" = 1 ]; then rules='[{"source":"/<*>","target":"/index.html","status":"200"}]'; fi
    FAKE_RULES="$rules" node -e 'const e=process.env; console.log(JSON.stringify({app:{appId:e.FSK_AMPLIFY_APP_ID,appArn:["arn","aws","amplify",e.FSK_EXPECTED_AWS_REGION,e.FSK_EXPECTED_AWS_ACCOUNT_ID,"apps/"+e.FSK_AMPLIFY_APP_ID].join(":"),name:"FSK",repository:e.FSK_GIT_REMOTE_URL,platform:"WEB_COMPUTE",tags:{Project:"FSK",Environment:"production",ManagedBy:"AmplifyGen2",CostCenter:"FSK"},customRules:JSON.parse(e.FAKE_RULES)}}))'
    ;;
  get-branch)
    if [ "\${FAKE_BRANCH_ERROR:-0}" = 1 ]; then printf 'AccessDeniedException\\n' >&2; exit 254; fi
    state="$FAKE_BRANCH_STATE"
    if [ "\${FAKE_BRANCH_MISSING_ONCE:-0}" = 1 ] && [ ! -e "$state" ]; then : > "$state"; printf 'NotFoundException\\n' >&2; exit 254; fi
    if [[ " $* " == *" --query branch.branchName "* ]]; then printf '%s\\n' "$FSK_AMPLIFY_BRANCH"; exit 0; fi
    node -e 'const e=process.env; const values={FSK_EXPECTED_AWS_ACCOUNT_ID:e.FSK_EXPECTED_AWS_ACCOUNT_ID,FSK_EXPECTED_AWS_REGION:e.FSK_EXPECTED_AWS_REGION,FSK_EXPECTED_AMPLIFY_APP_ID:e.FSK_AMPLIFY_APP_ID,FSK_EXPECTED_AMPLIFY_BRANCH:e.FSK_AMPLIFY_BRANCH,FSK_EXPECTED_DEPLOY_COMMIT:e.FSK_DEPLOY_COMMIT}; const environmentVariables=e.FAKE_REVERSE_ENV==="1"?Object.fromEntries(Object.entries(values).reverse()):values; console.log(JSON.stringify({branch:{branchName:e.FSK_AMPLIFY_BRANCH,stage:e.FAKE_BRANCH_DRIFT==="1"?"DEVELOPMENT":"PRODUCTION",framework:"Vue",enableAutoBuild:false,environmentVariables}}))'
    ;;
  create-branch|update-branch|update-app) printf '{}\\n' ;;
  start-job) printf 'job-1\\n' ;;
  get-job)
    commit="$FSK_DEPLOY_COMMIT"
    if [ "\${FAKE_STALE_JOB:-0}" = 1 ]; then commit=0000000000000000000000000000000000000000; fi
    FAKE_JOB_COMMIT="$commit" node -e 'console.log(JSON.stringify({job:{summary:{jobId:"job-1",status:"SUCCEED",commitId:process.env.FAKE_JOB_COMMIT}}}))'
    ;;
  *) printf '{}\\n' ;;
esac
`);
  executable(join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case "\${1:-}" in
  rev-parse) printf '%s\\n' "$FSK_DEPLOY_COMMIT" ;;
  status) ;;
  remote) printf '%s\\n' "\${FAKE_REMOTE_URL_OVERRIDE:-$FSK_GIT_REMOTE_URL}" ;;
  ls-remote) printf '%s\\trefs/heads/%s\\n' "$FSK_DEPLOY_COMMIT" "$FSK_AMPLIFY_BRANCH" ;;
  push) ;;
  check-ignore) ;;
  ls-files) ;;
esac
`);
  executable(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
output=''
headers=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) output="$2"; shift 2 ;; -D) headers="$2"; shift 2 ;; *) shift ;; esac
done
if [ -n "$headers" ]; then printf 'content-type: application/manifest+json\\n' > "$headers"; fi
case "$output" in *manifest.json) printf '{"display":"standalone"}\\n' > "$output" ;; *) printf '<div id="app"></div>\\n' > "$output" ;; esac
`);
  executable(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(join(bin, 'corepack'), '#!/usr/bin/env bash\nprintf "corepack %s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n');
  executable(join(bin, 'pnpm'), `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [[ " $* " == *" pipeline-deploy "* ]]; then mkdir -p apps/web/public; printf '{}\\n' > apps/web/public/amplify_outputs.json; fi
`);
  return { bin, log };
}

function gateEnvironment(root: string, bin: string): NodeJS.ProcessEnv {
  const commit = '1234567890abcdef1234567890abcdef12345678';
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: join(root, 'commands.log'),
    FAKE_BRANCH_STATE: join(root, 'branch.state'),
    FSK_GATE_A_APPROVAL_ID: 'gate-a-approved',
    FSK_GATE_B_APPROVAL_ID: 'gate-b-approved',
    FSK_GATE_C_APPROVAL_ID: 'gate-c-approved',
    FSK_EXPECTED_AWS_ACCOUNT_ID: '444083008754',
    FSK_EXPECTED_AWS_REGION: 'ap-northeast-1',
    FSK_AMPLIFY_APP_ID: 'd1234567890abc',
    FSK_EXPECTED_AMPLIFY_APP_ID: 'd1234567890abc',
    FSK_AMPLIFY_BRANCH: 'fsk-release',
    FSK_EXPECTED_AMPLIFY_BRANCH: 'fsk-release',
    FSK_DEPLOY_COMMIT: commit,
    FSK_EXPECTED_DEPLOY_COMMIT: commit,
    FSK_AMPLIFY_APP_NAME: 'FSK',
    FSK_HOSTING_URL: 'https://fsk.example.test',
    FSK_GIT_REMOTE: 'origin',
    FSK_GIT_REMOTE_URL: 'https://example.test/fsk.git',
    FSK_DEPLOY_DEADLINE_EPOCH: '4102444800',
    AWS_APP_ID: 'd1234567890abc',
    AWS_BRANCH: 'fsk-release',
    AWS_COMMIT_ID: commit,
    AWS_REGION: 'ap-northeast-1',
    AWS_DEFAULT_REGION: 'ap-northeast-1',
  };
}

interface RetirementItem {
  category: string;
  arn: string;
  resourceType: string;
  retentionPolicy: string;
  owner: string;
}

function writeRetirementFixture(root: string, mutate?: (input: {
  manifest: Record<string, unknown>;
  newFsk: RetirementItem[];
  gameList: RetirementItem[];
}) => void): { manifestPath: string; newFskPath: string; gameListPath: string } {
  const item = (
    category: string,
    arn: string,
    resourceType: string,
  ): RetirementItem => ({
    category,
    arn,
    resourceType,
    retentionPolicy: 'DO_NOT_DELETE',
    owner: 'reiken',
  });
  const newFsk = [
    item('NEW_FSK_AMPLIFY_APP', 'arn:aws:amplify:ap-northeast-1:444083008754:apps/d1234567890abc', 'AWS::Amplify::App'),
    item('NEW_FSK_COGNITO_POOL', 'arn:aws:cognito-idp:ap-northeast-1:444083008754:userpool/ap-northeast-1_NEWFSK', 'AWS::Cognito::UserPool'),
    item('NEW_FSK_APPSYNC_API', 'arn:aws:appsync:ap-northeast-1:444083008754:apis/newfskapi', 'AWS::AppSync::GraphQLApi'),
    ...['ShiftDefinition', 'ResponsiblePerson', 'AppSetting', 'DailyReport'].map((name) =>
      item('NEW_FSK_DYNAMODB_TABLE', `arn:aws:dynamodb:ap-northeast-1:444083008754:table/${name}-newfsk`, 'AWS::DynamoDB::Table'),
    ),
    item('NEW_FSK_STORAGE_BUCKET', 'arn:aws:s3:::fsk-new-storage-bucket', 'AWS::S3::Bucket'),
    item('NEW_FSK_FUNCTION', 'arn:aws:lambda:ap-northeast-1:444083008754:function:fsk-kitchen-context', 'AWS::Lambda::Function'),
    item('NEW_FSK_CLOUDFORMATION_STACK', 'arn:aws:cloudformation:ap-northeast-1:444083008754:stack/amplify-fsk-new/11111111-1111-1111-1111-111111111111', 'AWS::CloudFormation::Stack'),
  ];
  const gameList = [
    item('GAMELIST_RESOURCE', 'arn:aws:amplify:ap-northeast-1:444083008754:apps/dgamelist123456', 'AWS::Amplify::App'),
  ];
  const retire: RetirementItem[] = [{
    category: 'LEGACY_FSK_STACK',
    arn: 'arn:aws:cloudformation:ap-northeast-1:444083008754:stack/FskStagingFoundation/22222222-2222-2222-2222-222222222222',
    resourceType: 'AWS::CloudFormation::Stack',
    retentionPolicy: 'DELETE_AFTER_APPROVED_FINAL_SNAPSHOT',
    owner: 'reiken',
  }];
  const newFskPath = join(root, 'new-fsk-protect.json');
  const gameListPath = join(root, 'gamelist-protect.json');
  writeFileSync(newFskPath, `${JSON.stringify(newFsk, null, 2)}\n`);
  writeFileSync(gameListPath, `${JSON.stringify(gameList, null, 2)}\n`);
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    approvalId: 'gate-c-approved',
    accountId: '444083008754',
    region: 'ap-northeast-1',
    newSystemCommit: '1234567890abcdef1234567890abcdef12345678',
    observationEndedAt: '2026-09-30T00:00:00.000Z',
    newFskProtectSetSha256: sha256(newFskPath),
    gameListProtectSetSha256: sha256(gameListPath),
    retire,
    protect: [...newFsk, ...gameList],
  };
  mutate?.({ manifest, newFsk, gameList });
  writeFileSync(newFskPath, `${JSON.stringify(newFsk, null, 2)}\n`);
  writeFileSync(gameListPath, `${JSON.stringify(gameList, null, 2)}\n`);
  manifest.newFskProtectSetSha256 = sha256(newFskPath);
  manifest.gameListProtectSetSha256 = sha256(gameListPath);
  const manifestPath = join(root, 'retirement.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, newFskPath, gameListPath };
}

describe('DynamoDB Hosting deployment contract', () => {
  it('installs immutably, validates an exact target, deploys Gen 2 outputs, checks, then builds the Web artifact', () => {
    const config = parseJsonYaml<BuildSpec>('amplify.yml');
    const backend = config.backend.phases.build.commands;
    const frontend = config.frontend.phases.build.commands;
    const installIndex = backend.indexOf('pnpm install --frozen-lockfile');
    const deployIndex = backend.findIndex((command) =>
      command.startsWith('CI=1 pnpm exec ampx pipeline-deploy '),
    );
    const outputCheckIndex = backend.indexOf(
      'test -s apps/web/public/amplify_outputs.json',
    );
    const targetGuards = [
      'AWS_APP_ID',
      'AWS_BRANCH',
      'AWS_COMMIT_ID',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'FSK_EXPECTED_AWS_ACCOUNT_ID',
      'FSK_EXPECTED_AWS_REGION',
      'FSK_EXPECTED_AMPLIFY_APP_ID',
      'FSK_EXPECTED_AMPLIFY_BRANCH',
      'FSK_EXPECTED_DEPLOY_COMMIT',
    ];

    expect(config.version).toBe(1);
    expect(backend.filter((command) => /\b(?:pnpm|npm) install\b/.test(command))).toEqual([
      'pnpm install --frozen-lockfile',
    ]);
    expect(installIndex).toBeGreaterThan(backend.indexOf('corepack prepare pnpm@9.15.0 --activate'));
    for (const variable of targetGuards) {
      const guardIndex = backend.findIndex((command) =>
        command.startsWith(`: "\${${variable}:?`),
      );
      expect(guardIndex, variable).toBeGreaterThanOrEqual(0);
      expect(guardIndex, variable).toBeLessThan(installIndex);
    }
    expect(backend[deployIndex]).toBe(
      'CI=1 pnpm exec ampx pipeline-deploy --branch "$FSK_EXPECTED_AMPLIFY_BRANCH" --app-id "$FSK_EXPECTED_AMPLIFY_APP_ID" --outputs-out-dir apps/web/public',
    );
    expect(backend.filter((command) => command.includes('pipeline-deploy'))).toHaveLength(1);
    expect(outputCheckIndex).toBeGreaterThan(deployIndex);
    expect(backend.slice(outputCheckIndex)).toContain(
      'git check-ignore -q apps/web/public/amplify_outputs.json',
    );
    expect(backend.slice(outputCheckIndex)).toContain(
      'test -z "$(git ls-files -- apps/web/public/amplify_outputs.json)"',
    );
    expect(frontend).toEqual(['pnpm run check:all', 'pnpm run build:web']);
    expect(config.frontend.artifacts).toEqual({
      baseDirectory: 'apps/web/dist',
      files: ['**/*'],
    });
  });

  it('fails a mismatched Amplify build target before dependency installation and runs identity checks before tools on a matching target', () => {
    const backend = parseJsonYaml<BuildSpec>('amplify.yml').backend.phases.build.commands;
    const root = temporaryRoot('fsk-task12-build-');
    const { bin, log } = createFakeCommandBin(root);
    const cwd = join(root, 'checkout');
    mkdirSync(join(cwd, 'apps/web/public'), { recursive: true });
    const environment = gateEnvironment(root, bin);
    const script = `set -euo pipefail\n${backend.join('\n')}\n`;

    const mismatch = spawnSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: { ...environment, AWS_APP_ID: 'wrong-app' },
    });
    expect(mismatch.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toMatch(/corepack|pnpm/);

    writeFileSync(log, '');
    const matching = spawnSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: environment,
    });
    expect(matching.status, matching.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.findIndex((value) => value.startsWith('aws sts '))).toBeLessThan(
      calls.findIndex((value) => value.startsWith('corepack ')),
    );
    expect(calls.findIndex((value) => value === 'pnpm install --frozen-lockfile')).toBeLessThan(
      calls.findIndex((value) => value.includes('pipeline-deploy')),
    );
  });

  it('serves generated/static files directly while rewriting only extensionless SPA routes', () => {
    const config = parseJsonYaml<HttpConfig>('customHttp.yml');
    const deployment = read('docs/aws/dynamodb-deployment-runbook.md');
    const [rules] = extractFences(deployment, 'json').map(
      (value) => JSON.parse(value) as RewriteRule[],
    );

    expect(headersFor(config, '/manifest.json')).toEqual({
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': 'application/manifest+json; charset=utf-8',
    });
    expect(headersFor(config, '/amplify_outputs.json')).toEqual({
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': 'application/json; charset=utf-8',
    });
    expect(headersFor(config, '/icons/icon-180.png')).toEqual({
      'cache-control': 'public, max-age=86400',
      'content-type': 'image/png',
    });
    expect(headersFor(config, '/assets/app-a1b2c3.js')).toEqual({
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(rules).toEqual([
      { source: '</^[^.]+$/>', target: '/index.html', status: '200' },
    ]);
    expect(resolveHostingPath('/owner/reports', rules)).toBe('/index.html');
    expect(resolveHostingPath('/kitchen/report/new', rules)).toBe('/index.html');
    expect(resolveHostingPath('/manifest.json', rules)).toBe('/manifest.json');
    expect(resolveHostingPath('/icons/icon-180.png', rules)).toBe('/icons/icon-180.png');
    expect(resolveHostingPath('/assets/app-a1b2c3.js', rules)).toBe('/assets/app-a1b2c3.js');
    expect(resolveHostingPath('/missing.bin', rules)).toBe('/missing.bin');
  });

  it('runs the documented Gate B commands through the real pnpm scripts and exact output names without a literal separator', () => {
    const fixture = createMigrationCliFixture();
    const commands = migrationCommandLines();
    const environment = {
      ...process.env,
      FSK_GATE_B_APPROVAL_ID: 'gate-b-approved',
      FSK_SQLITE_SNAPSHOT: fixture.sqlitePath,
      FSK_UPLOADS_SNAPSHOT: fixture.uploadsPath,
      FSK_MIGRATION_OUTPUT_DIR: fixture.outputPath,
      FSK_TARGET_CONFIG: fixture.targetConfigPath,
    };

    expect(Object.values(commands).every((command) => !command.includes(' -- --'))).toBe(true);
    const dryRun = spawnSync('bash', ['-c', commands.dryRun], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
    const bundlePath = join(fixture.outputPath, 'migration-bundle.json');
    expect(readdirSync(fixture.outputPath).sort()).toEqual([
      'migration-bundle.json',
      'migration-report.json',
      'migration-status.json',
    ]);
    expect(JSON.parse(readFileSync(bundlePath, 'utf8'))).toMatchObject({
      appSetting: { id: 'default' },
      dailyReports: [],
      shifts: [],
    });
    expect(JSON.parse(readFileSync(join(fixture.outputPath, 'migration-report.json'), 'utf8'))).toMatchObject({
      conflicts: [],
      modelCounts: { appSettings: 1, dailyReports: 0 },
    });
    expect(JSON.parse(readFileSync(join(fixture.outputPath, 'migration-status.json'), 'utf8'))).toEqual({
      status: 'complete',
      errorCode: null,
    });

    const importResult = spawnSync('bash', ['-c', commands.import], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(importResult.status).not.toBe(0);
    expect(`${importResult.stdout}\n${importResult.stderr}`).toContain('TARGET_CONFIG_UNKNOWN_FIELD');
    expect(`${importResult.stdout}\n${importResult.stderr}`).not.toContain('IMPORT_ARGUMENT_UNKNOWN:--');

    const verifyResult = spawnSync('bash', ['-c', commands.verify], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(verifyResult.status).not.toBe(0);
    expect(`${verifyResult.stdout}\n${verifyResult.stderr}`).toContain('TARGET_CONFIG_UNKNOWN_FIELD');
    expect(`${verifyResult.stdout}\n${verifyResult.stderr}`).not.toContain('VERIFY_ARGUMENT_UNKNOWN:--');
    expect(verifyResult.stdout).not.toContain('"status":"dry-run"');
  }, 90_000);

  it('bootstraps and reads back the exact isolated Hosting branch/rule, CAS-publishes the commit, and reaches HTTP only after a matching successful job', () => {
    const [script] = extractFences(read('docs/aws/dynamodb-deployment-runbook.md'), 'bash');
    const root = temporaryRoot('fsk-task12-gate-a-');
    const { bin, log } = createFakeCommandBin(root);
    const environment = {
      ...gateEnvironment(root, bin),
      FAKE_BRANCH_MISSING_ONCE: '1',
      FAKE_REVERSE_ENV: '1',
    };
    const result = spawnSync('bash', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.some((value) => value.includes('amplify create-branch'))).toBe(true);
    expect(calls.some((value) => value.includes('amplify update-branch'))).toBe(true);
    expect(calls.some((value) => value.includes('amplify update-app') && value.includes('--custom-rules'))).toBe(true);
    expect(calls.some((value) => value.startsWith('git push ') && value.includes('--force-with-lease='))).toBe(true);
    const successfulJob = calls.findIndex((value) => value.includes('amplify get-job'));
    const firstHttp = calls.findIndex((value) => value.startsWith('curl '));
    expect(successfulJob).toBeGreaterThanOrEqual(0);
    expect(firstHttp).toBeGreaterThan(successfulJob);
  }, 30_000);

  it.each([
    ['unknown existing rewrite', { FAKE_UNKNOWN_RULES: '1' }],
    ['stale Hosting job commit', { FAKE_STALE_JOB: '1' }],
  ])('stops on %s before HTTP acceptance', (_name, extraEnvironment) => {
    const [script] = extractFences(read('docs/aws/dynamodb-deployment-runbook.md'), 'bash');
    const root = temporaryRoot('fsk-task12-gate-a-negative-');
    const { bin, log } = createFakeCommandBin(root);
    const result = spawnSync('bash', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...gateEnvironment(root, bin), ...extraEnvironment },
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('curl ');
  });

  it.each([
    ['non-NotFound branch read error', { FAKE_BRANCH_ERROR: '1' }],
    ['unknown existing branch state', { FAKE_BRANCH_DRIFT: '1' }],
    ['unapproved Git remote URL', { FAKE_REMOTE_URL_OVERRIDE: 'https://example.test/wrong.git' }],
    ['expired deployment deadline', { FSK_DEPLOY_DEADLINE_EPOCH: '1' }],
  ])('rejects %s before a mutable deployment command', (_name, extraEnvironment) => {
    const [script] = extractFences(read('docs/aws/dynamodb-deployment-runbook.md'), 'bash');
    const root = temporaryRoot('fsk-task12-gate-a-bootstrap-negative-');
    const { bin, log } = createFakeCommandBin(root);
    const result = spawnSync('bash', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...gateEnvironment(root, bin), ...extraEnvironment },
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).not.toMatch(
      /amplify (?:create-branch|update-branch|update-app|start-job)|git push |curl /,
    );
  });

  it('keeps deployment, real cutover, and retirement as three separately approved gates', () => {
    const documents = [
      read('docs/aws/dynamodb-deployment-runbook.md'),
      read('docs/aws/dynamodb-cutover-runbook.md'),
      read('docs/aws/dynamodb-retirement-runbook.md'),
    ];
    const contracts = documents.map(fields);

    expect(contracts.map((contract) => contract.get('Gate'))).toEqual([
      'Gate A — synthetic deployment',
      'Gate B — real data cutover',
      'Gate C — legacy retirement',
    ]);
    expect(contracts.map((contract) => contract.get('GateStatus'))).toEqual([
      'NOT_APPROVED',
      'NOT_APPROVED',
      'NOT_APPROVED',
    ]);
    expect(contracts.map((contract) => contract.get('ApprovalIdVariable'))).toEqual([
      'FSK_GATE_A_APPROVAL_ID',
      'FSK_GATE_B_APPROVAL_ID',
      'FSK_GATE_C_APPROVAL_ID',
    ]);
    expect(new Set(contracts.map((contract) => contract.get('AuthorizedEffects'))).size).toBe(3);
    expect(contracts[0].get('RealData')).toBe('FORBIDDEN');
    expect(contracts[0].get('LegacyFreeze')).toBe('FORBIDDEN');
    expect(contracts[0].get('LegacyDeletion')).toBe('FORBIDDEN');
    expect(contracts[1].get('LegacyDeletion')).toBe('FORBIDDEN');
    expect(contracts[2].get('Prerequisite')).toBe('Gate B accepted plus observation period complete');
  });

  it('accepts only a hashed exact Gate C retirement/protection manifest with complete new-FSK and authoritative GameList sets', () => {
    const [script] = extractFences(read('docs/aws/dynamodb-retirement-runbook.md'), 'bash');
    const run = (mutate?: Parameters<typeof writeRetirementFixture>[1]) => {
      const root = temporaryRoot('fsk-task12-gate-c-');
      const { bin } = createFakeCommandBin(root);
      const fixture = writeRetirementFixture(root, mutate);
      return spawnSync('bash', ['-c', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...gateEnvironment(root, bin),
          FSK_RETIREMENT_MANIFEST: fixture.manifestPath,
          FSK_RETIREMENT_MANIFEST_SHA256: sha256(fixture.manifestPath),
          FSK_NEW_FSK_PROTECT_SET: fixture.newFskPath,
          FSK_NEW_FSK_PROTECT_SET_SHA256: sha256(fixture.newFskPath),
          FSK_GAMELIST_PROTECT_SET: fixture.gameListPath,
          FSK_GAMELIST_PROTECT_SET_SHA256: sha256(fixture.gameListPath),
        },
        timeout: 10_000,
      });
    };

    const valid = run();
    expect(valid.status, valid.stderr).toBe(0);
    const invalidFixtures: Array<[string, Parameters<typeof writeRetirementFixture>[1]]> = [
      ['wildcard ARN', ({ manifest }) => {
        (manifest.retire as RetirementItem[])[0].arn = 'arn:aws:cloudformation:ap-northeast-1:444083008754:stack/*';
      }],
      ['cross-account ARN', ({ manifest }) => {
        (manifest.retire as RetirementItem[])[0].arn = 'arn:aws:cloudformation:ap-northeast-1:111111111111:stack/foreign/id';
      }],
      ['resource type and ARN subtype mismatch', ({ manifest }) => {
        (manifest.retire as RetirementItem[])[0] = {
          category: 'LEGACY_FSK_RDS_CLUSTER',
          arn: 'arn:aws:rds:ap-northeast-1:444083008754:db:legacy-instance',
          resourceType: 'AWS::RDS::DBCluster',
          retentionPolicy: 'DELETE_AFTER_APPROVED_FINAL_SNAPSHOT',
          owner: 'reiken',
        };
      }],
      ['duplicate protect ARN', ({ manifest }) => {
        const protect = manifest.protect as RetirementItem[];
        protect.push({ ...protect[0] });
      }],
      ['retire/protect overlap', ({ manifest }) => {
        (manifest.retire as RetirementItem[])[0] = { ...((manifest.protect as RetirementItem[])[0]), retentionPolicy: 'DELETE' };
      }],
      ['unknown item property', ({ manifest }) => {
        Object.assign((manifest.retire as RetirementItem[])[0], { wildcard: false });
      }],
      ['missing required new FSK category', ({ manifest, newFsk }) => {
        const index = newFsk.findIndex(({ category }) => category === 'NEW_FSK_FUNCTION');
        const [removed] = newFsk.splice(index, 1);
        manifest.protect = (manifest.protect as RetirementItem[]).filter(({ arn }) => arn !== removed.arn);
      }],
      ['category and resource type mismatch', ({ newFsk }) => {
        const fn = newFsk.find(({ category }) => category === 'NEW_FSK_FUNCTION')!;
        const stack = newFsk.find(({ category }) => category === 'NEW_FSK_CLOUDFORMATION_STACK')!;
        [fn.category, stack.category] = [stack.category, fn.category];
      }],
      ['non-ISO observation timestamp', ({ manifest }) => {
        manifest.observationEndedAt = '2026-09-30';
      }],
    ];
    for (const [name, mutate] of invalidFixtures) {
      const result = run(mutate);
      expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
    }
  }, 30_000);

  it('keeps every executable runbook block syntax-valid, strict, and fail-closed on its authorization tuple', () => {
    const runbooks = [
      ['docs/aws/dynamodb-deployment-runbook.md', 'FSK_GATE_A_APPROVAL_ID'],
      ['docs/aws/dynamodb-cutover-runbook.md', 'FSK_GATE_B_APPROVAL_ID'],
      ['docs/aws/dynamodb-retirement-runbook.md', 'FSK_GATE_C_APPROVAL_ID'],
    ] as const;
    const commonRequired = [
      'FSK_EXPECTED_AWS_ACCOUNT_ID',
      'FSK_EXPECTED_AWS_REGION',
      'FSK_AMPLIFY_APP_ID',
      'FSK_AMPLIFY_BRANCH',
      'FSK_DEPLOY_COMMIT',
    ];

    for (const [path, approvalVariable] of runbooks) {
      const blocks = extractFences(read(path), 'bash');
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const syntax = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
        expect(syntax.status, `${path}: ${syntax.stderr}`).toBe(0);
        expect(block.startsWith('set -euo pipefail\n')).toBe(true);
        for (const variable of [...commonRequired, approvalVariable]) {
          expect(block).toContain(`:\u00a0\"\${${variable}:?`.replace('\u00a0', ' '));
        }
        expect(block).toContain('test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"');
        expect(block).toContain('test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"');
        expect(block).toContain('test "${#FSK_DEPLOY_COMMIT}" -eq 40');
      }
    }
  });

  it('does not put the historical PostgreSQL foundation on an active command path', () => {
    const activeFiles = [
      'amplify.yml',
      'customHttp.yml',
      'docs/aws/dynamodb-deployment-runbook.md',
      'docs/aws/dynamodb-cutover-runbook.md',
      'docs/aws/dynamodb-retirement-runbook.md',
    ];
    const forbiddenCommand = /(?:ampx|aws|pnpm|npm|npx).*?(?:aurora|rds|postgres|data-api|vpc|nat|db:staging|backend\.foundation)/iu;

    for (const path of activeFiles) {
      const bash = extractFences(read(path), 'bash').map(executableShell).join('\n');
      const buildCommands = path === 'amplify.yml'
        ? JSON.stringify(parseJsonYaml<BuildSpec>(path))
        : '';
      expect(`${bash}\n${buildCommands}`, path).not.toMatch(forbiddenCommand);
    }
  });
});
