import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  assertExplicitTargetConfiguration,
  createAwsMigrationTarget,
  type TargetConfiguration,
} from './target';

export interface ProvisioningTargetSafety {
  assertSafeTarget(): Promise<void>;
}

export interface CognitoUserDirectory {
  getUser(username: string): Promise<{ groups: string[] } | null>;
  createUser(username: string, temporaryPassword: string): Promise<void>;
  addUserToGroup(username: string, group: 'OWNER' | 'KITCHEN'): Promise<void>;
}

interface CommandClient {
  send(command: { input?: Record<string, unknown> }): Promise<unknown>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export class AwsCognitoUserDirectory implements CognitoUserDirectory {
  constructor(
    readonly userPoolId: string,
    readonly client: CommandClient,
  ) {
    if (!/^ap-northeast-1_[A-Za-z0-9]+$/u.test(userPoolId)) {
      throw new Error('COGNITO_USER_POOL_ID_INVALID');
    }
  }

  async getUser(username: string): Promise<{ groups: string[] } | null> {
    let user: {
      Username?: string;
      UserAttributes?: Array<{ Name?: string; Value?: string }>;
    };
    try {
      user = (await this.client.send(
        new AdminGetUserCommand({
          UserPoolId: this.userPoolId,
          Username: username,
        }) as unknown as { input?: Record<string, unknown> },
      )) as typeof user;
    } catch (error) {
      if (errorName(error) === 'UserNotFoundException') return null;
      throw error;
    }
    if (user.Username !== undefined && user.Username !== username) {
      throw new Error(`COGNITO_USERNAME_COLLISION:${username}`);
    }
    const forbiddenAttribute = (user.UserAttributes ?? []).find(
      ({ Name }) => Name !== 'sub',
    );
    if (forbiddenAttribute) {
      throw new Error(`COGNITO_USER_ATTRIBUTE_CONFLICT:${username}`);
    }
    const groups: string[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    do {
      const page = (await this.client.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: this.userPoolId,
          Username: username,
          NextToken: nextToken,
        }) as unknown as { input?: Record<string, unknown> },
      )) as { Groups?: Array<{ GroupName?: string }>; NextToken?: string };
      for (const group of page.Groups ?? []) {
        if (typeof group.GroupName !== 'string' || group.GroupName.length === 0) {
          throw new Error(`COGNITO_USER_GROUP_RESULT_INVALID:${username}`);
        }
        groups.push(group.GroupName);
      }
      nextToken = page.NextToken;
      if (nextToken) {
        if (seenTokens.has(nextToken)) {
          throw new Error(`COGNITO_USER_GROUP_PAGINATION_CYCLE:${username}`);
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken);
    if (new Set(groups).size !== groups.length) {
      throw new Error(`COGNITO_USER_GROUP_RESULT_INVALID:${username}`);
    }
    return { groups: groups.sort() };
  }

  async createUser(username: string, temporaryPassword: string): Promise<void> {
    await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        TemporaryPassword: temporaryPassword,
        MessageAction: 'SUPPRESS',
        UserAttributes: [],
      }) as unknown as { input?: Record<string, unknown> },
    );
  }

  async addUserToGroup(username: string, group: 'OWNER' | 'KITCHEN'): Promise<void> {
    await this.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: group,
      }) as unknown as { input?: Record<string, unknown> },
    );
  }
}

export interface ProvisionUsersCliOptions {
  mode: 'dry-run' | 'apply';
  approvalId?: string;
  targetConfigPath?: string;
  ownerUsername?: string;
  kitchenUsername?: string;
}

function argumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`PROVISION_ARGUMENT_VALUE_REQUIRED:${flag}`);
  }
  return value;
}

export function parseProvisionUsersCliOptions(argv: string[]): ProvisionUsersCliOptions {
  const forbidden = argv.find((argument) =>
    /^--.*(?:password|secret|email|phone|contact|role|hash|webmaster|admin)/iu.test(argument),
  );
  if (forbidden) throw new Error('PROVISION_FORBIDDEN_ARGUMENT');
  const valued = new Set([
    '--approval-id',
    '--target-config',
    '--owner-username',
    '--kitchen-username',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`PROVISION_ARGUMENT_VALUE_REQUIRED:${argument}`);
      }
    } else if (!['--apply', '--dry-run'].includes(argument)) {
      throw new Error(`PROVISION_ARGUMENT_UNKNOWN:${argument}`);
    }
  }
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('PROVISION_MODE_CONFLICT');
  const approvalId = argumentValue(argv, '--approval-id')?.trim();
  const targetConfigPath = argumentValue(argv, '--target-config');
  if (apply && !approvalId) throw new Error('PROVISION_APPROVAL_ID_REQUIRED');
  if (apply && !targetConfigPath) throw new Error('PROVISION_TARGET_CONFIG_REQUIRED');
  return {
    mode: apply ? 'apply' : 'dry-run',
    approvalId,
    targetConfigPath,
    ownerUsername: argumentValue(argv, '--owner-username'),
    kitchenUsername: argumentValue(argv, '--kitchen-username'),
  };
}

type ProvisionOutcome = 'created' | 'group-added' | 'unchanged' | 'planned';

export interface ProvisionedCognitoUserOutcome {
  username: string;
  group: 'OWNER' | 'KITCHEN';
  outcome: ProvisionOutcome;
}

export class CognitoProvisionPartialError extends Error {
  readonly code = 'COGNITO_PROVISION_PARTIAL_FAILURE';
  constructor(
    readonly username: string,
    readonly userCreation: 'not-needed' | 'not-attempted' | 'confirmed' | 'unknown',
    readonly groupMembership: 'not-attempted' | 'confirmed' | 'unknown',
    readonly failureCode: string,
    readonly completedUsers: readonly ProvisionedCognitoUserOutcome[] = [],
  ) {
    super('COGNITO_PROVISION_PARTIAL_FAILURE');
  }
}

export function formatProvisionUsersCliError(error: unknown): Record<string, unknown> {
  if (error instanceof CognitoProvisionPartialError) {
    return {
      code: error.code,
      completedUsers: error.completedUsers,
      username: error.username,
      userCreation: error.userCreation,
      groupMembership: error.groupMembership,
      failureCode: error.failureCode,
    };
  }
  return { code: sanitizedFailureCode(error) };
}

function validateUsername(username: string, role: 'OWNER' | 'KITCHEN'): void {
  if (
    username.trim() !== username ||
    username.length < 1 ||
    username.length > 128 ||
    !/^[\p{L}\p{N}_.@+-]+$/u.test(username) ||
    /webmaster|admin/i.test(username)
  ) {
    throw new Error(`COGNITO_USERNAME_INVALID:${role}`);
  }
}

function sanitizedFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]+$/u.test(error.message)) {
    return error.message.slice(0, 300);
  }
  const name = errorName(error);
  return /^[A-Za-z0-9_]+$/u.test(name) ? name : 'UNCLASSIFIED_COGNITO_FAILURE';
}

function assertExistingGroups(
  username: string,
  desiredGroup: 'OWNER' | 'KITCHEN',
  groups: string[],
): void {
  if (
    groups.length > 1 ||
    (groups.length === 1 && groups[0] !== desiredGroup) ||
    groups.some((group) => !['OWNER', 'KITCHEN'].includes(group))
  ) {
    throw new Error(`COGNITO_USER_GROUP_CONFLICT:${username}`);
  }
}

export async function provisionCognitoUsers(input: {
  mode: 'dry-run' | 'apply';
  approvalId?: string;
  ownerUsername: string;
  kitchenUsername: string;
  environment: NodeJS.ProcessEnv;
  safety: ProvisioningTargetSafety;
  directory: CognitoUserDirectory;
}): Promise<{
  status: 'dry-run' | 'complete';
  users: Array<{
    username: string;
    group: 'OWNER' | 'KITCHEN';
    outcome: ProvisionOutcome;
  }>;
}> {
  validateUsername(input.ownerUsername, 'OWNER');
  validateUsername(input.kitchenUsername, 'KITCHEN');
  if (input.ownerUsername === input.kitchenUsername) {
    throw new Error('COGNITO_USERNAMES_MUST_DIFFER');
  }
  const requested = [
    { username: input.ownerUsername, group: 'OWNER' as const, passwordEnvironment: 'FSK_OWNER_TEMP_PASSWORD' as const },
    { username: input.kitchenUsername, group: 'KITCHEN' as const, passwordEnvironment: 'FSK_KITCHEN_TEMP_PASSWORD' as const },
  ];
  if (input.mode === 'dry-run') {
    return {
      status: 'dry-run',
      users: requested.map(({ username, group }) => ({ username, group, outcome: 'planned' })),
    };
  }
  if (!input.approvalId?.trim()) throw new Error('PROVISION_APPROVAL_ID_REQUIRED');
  const passwords = requested.map(({ passwordEnvironment }) => {
    const password = input.environment[passwordEnvironment];
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error(`COGNITO_TEMP_PASSWORD_ENV_REQUIRED:${passwordEnvironment}`);
    }
    return password;
  });
  await input.safety.assertSafeTarget();

  const existing = await Promise.all(
    requested.map(({ username }) => input.directory.getUser(username)),
  );
  existing.forEach((user, index) => {
    if (user) {
      assertExistingGroups(requested[index].username, requested[index].group, user.groups);
    }
  });

  const users: ProvisionedCognitoUserOutcome[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const { username, group } = requested[index];
    const user = existing[index];
    if (user?.groups[0] === group) {
      users.push({ username, group, outcome: 'unchanged' });
      continue;
    }
    let userCreation: CognitoProvisionPartialError['userCreation'] = user
      ? 'not-needed'
      : 'not-attempted';
    let groupMembership: CognitoProvisionPartialError['groupMembership'] =
      'not-attempted';
    try {
      if (!user) {
        userCreation = 'unknown';
        await input.directory.createUser(username, passwords[index]);
        userCreation = 'confirmed';
      }
      groupMembership = 'unknown';
      await input.directory.addUserToGroup(username, group);
      groupMembership = 'confirmed';
      users.push({
        username,
        group,
        outcome: userCreation === 'confirmed' ? 'created' : 'group-added',
      });
    } catch (error) {
      throw new CognitoProvisionPartialError(
        username,
        userCreation,
        groupMembership,
        sanitizedFailureCode(error),
        users.map((completed) => ({ ...completed })),
      );
    }
  }
  return { status: 'complete', users };
}

function readTargetConfig(path: string): TargetConfiguration {
  if (!isAbsolute(path)) throw new Error('PROVISION_TARGET_CONFIG_PATH_NOT_ABSOLUTE');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('PROVISION_TARGET_CONFIG_PATH_INVALID');
  }
  const value = JSON.parse(readFileSync(realpathSync(path), 'utf8')) as unknown;
  assertExplicitTargetConfiguration(value);
  return value;
}

export async function runProvisionUsersCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const options = parseProvisionUsersCliOptions(argv);
  if (!options.ownerUsername || !options.kitchenUsername) {
    throw new Error('PROVISION_USERNAMES_REQUIRED');
  }
  if (options.mode === 'dry-run') {
    const neverSafety: ProvisioningTargetSafety = {
      async assertSafeTarget() { throw new Error('DRY_RUN_TARGET_CALLED'); },
    };
    const neverDirectory: CognitoUserDirectory = {
      async getUser() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async createUser() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async addUserToGroup() { throw new Error('DRY_RUN_TARGET_CALLED'); },
    };
    return provisionCognitoUsers({
      mode: 'dry-run',
      ownerUsername: options.ownerUsername,
      kitchenUsername: options.kitchenUsername,
      environment,
      safety: neverSafety,
      directory: neverDirectory,
    });
  }
  const config = readTargetConfig(options.targetConfigPath!);
  return provisionCognitoUsers({
    mode: 'apply',
    approvalId: options.approvalId,
    ownerUsername: options.ownerUsername,
    kitchenUsername: options.kitchenUsername,
    environment,
    safety: createAwsMigrationTarget(config),
    directory: new AwsCognitoUserDirectory(
      config.userPool.id,
      new CognitoIdentityProviderClient({ region: config.region }) as unknown as CommandClient,
    ),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runProvisionUsersCli(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(JSON.stringify(formatProvisionUsersCliError(error)));
      process.exitCode = 1;
    },
  );
}
