import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const extractFences = (document: string, language: string): string[] =>
  [
    ...document.matchAll(
      new RegExp(`^${'```'}${language}\\n([\\s\\S]*?)^${'```'}$`, 'gm'),
    ),
  ].map((match) => match[1]);

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
      expect(guardIndex, variable).toBeGreaterThan(installIndex);
      expect(guardIndex, variable).toBeLessThan(deployIndex);
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
      'cache-control': 'public, max-age=31536000, immutable',
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
      const bash = extractFences(read(path), 'bash').join('\n');
      const buildCommands = path === 'amplify.yml'
        ? JSON.stringify(parseJsonYaml<BuildSpec>(path))
        : '';
      expect(`${bash}\n${buildCommands}`, path).not.toMatch(forbiddenCommand);
    }
  });
});
