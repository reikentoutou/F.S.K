import { describe, expect, it } from 'vitest';
import {
  AwsCognitoUserDirectory,
  CognitoProvisionPartialError,
  formatProvisionUsersCliError,
  parseProvisionUsersCliOptions,
  provisionCognitoUsers,
  type CognitoUserDirectory,
  type ProvisioningTargetSafety,
} from './provision-users';

class FakeSafety implements ProvisioningTargetSafety {
  calls = 0;
  async assertSafeTarget(): Promise<void> {
    this.calls += 1;
  }
}

class MemoryUserDirectory implements CognitoUserDirectory {
  readonly users = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  failCreateFor?: string;
  failAddFor?: string;

  async getUser(username: string): Promise<{ groups: string[] } | null> {
    this.calls.push(`get:${username}`);
    const groups = this.users.get(username);
    return groups ? { groups: [...groups].sort() } : null;
  }

  async createUser(username: string, _temporaryPassword: string): Promise<void> {
    this.calls.push(`create:${username}`);
    if (this.failCreateFor === username) throw new Error('SYNTHETIC_CREATE_UNKNOWN');
    if (this.users.has(username)) throw new Error('USERNAME_EXISTS');
    this.users.set(username, new Set());
  }

  async addUserToGroup(username: string, group: 'OWNER' | 'KITCHEN'): Promise<void> {
    this.calls.push(`group:${username}:${group}`);
    if (this.failAddFor === username) throw new Error('SYNTHETIC_GROUP_FAILURE');
    this.users.get(username)?.add(group);
  }
}

describe('Cognito OWNER/KITCHEN provisioning', () => {
  it('creates exactly two username-only users and assigns the exact business groups', async () => {
    const safety = new FakeSafety();
    const directory = new MemoryUserDirectory();
    const result = await provisionCognitoUsers({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-USERS',
      ownerUsername: 'fsk-owner',
      kitchenUsername: 'fsk-kitchen',
      environment: {
        FSK_OWNER_TEMP_PASSWORD: 'Owner-Temporary-Secret1!',
        FSK_KITCHEN_TEMP_PASSWORD: 'Kitchen-Temporary-Secret1!',
      },
      safety,
      directory,
    });

    expect(safety.calls).toBe(1);
    expect(directory.users).toEqual(
      new Map([
        ['fsk-owner', new Set(['OWNER'])],
        ['fsk-kitchen', new Set(['KITCHEN'])],
      ]),
    );
    expect(result).toEqual({
      status: 'complete',
      users: [
        { username: 'fsk-owner', group: 'OWNER', outcome: 'created' },
        { username: 'fsk-kitchen', group: 'KITCHEN', outcome: 'created' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Temporary|Secret|password/i);
  });

  it('is idempotent when both users already belong only to their required group', async () => {
    const directory = new MemoryUserDirectory();
    directory.users.set('fsk-owner', new Set(['OWNER']));
    directory.users.set('fsk-kitchen', new Set(['KITCHEN']));
    const result = await provisionCognitoUsers({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-USERS-2',
      ownerUsername: 'fsk-owner',
      kitchenUsername: 'fsk-kitchen',
      environment: {
        FSK_OWNER_TEMP_PASSWORD: 'Owner-Temporary-Secret1!',
        FSK_KITCHEN_TEMP_PASSWORD: 'Kitchen-Temporary-Secret1!',
      },
      safety: new FakeSafety(),
      directory,
    });
    expect(result.users.map((user) => user.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(directory.calls.every((call) => call.startsWith('get:'))).toBe(true);
  });

  it('fails closed on legacy, extra, or wrong group membership without mutation', async () => {
    for (const groups of [
      ['WEBMASTER'],
      ['ADMIN'],
      ['OWNER', 'KITCHEN'],
      ['KITCHEN'],
    ]) {
      const directory = new MemoryUserDirectory();
      directory.users.set('fsk-owner', new Set(groups));
      await expect(
        provisionCognitoUsers({
          mode: 'apply',
          approvalId: 'FSK-TASK11-SYNTHETIC-USERS-3',
          ownerUsername: 'fsk-owner',
          kitchenUsername: 'fsk-kitchen',
          environment: {
            FSK_OWNER_TEMP_PASSWORD: 'Owner-Temporary-Secret1!',
            FSK_KITCHEN_TEMP_PASSWORD: 'Kitchen-Temporary-Secret1!',
          },
          safety: new FakeSafety(),
          directory,
        }),
      ).rejects.toThrow('COGNITO_USER_GROUP_CONFLICT:fsk-owner');
      expect(directory.calls.some((call) => call.startsWith('create:'))).toBe(false);
      expect(directory.calls.some((call) => call.startsWith('group:'))).toBe(false);
    }
  });

  it('dry-run and missing-password validation make zero mutations', async () => {
    const dryDirectory = new MemoryUserDirectory();
    const dry = await provisionCognitoUsers({
      mode: 'dry-run',
      ownerUsername: 'fsk-owner',
      kitchenUsername: 'fsk-kitchen',
      environment: {},
      safety: new FakeSafety(),
      directory: dryDirectory,
    });
    expect(dry.status).toBe('dry-run');
    expect(dryDirectory.calls).toEqual([]);

    const applyDirectory = new MemoryUserDirectory();
    await expect(
      provisionCognitoUsers({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-USERS-4',
        ownerUsername: 'fsk-owner',
        kitchenUsername: 'fsk-kitchen',
        environment: { FSK_OWNER_TEMP_PASSWORD: 'one-secret' },
        safety: new FakeSafety(),
        directory: applyDirectory,
      }),
    ).rejects.toThrow('COGNITO_TEMP_PASSWORD_ENV_REQUIRED');
    expect(applyDirectory.calls).toEqual([]);
  });

  it('reports a partial user outcome without leaking either temporary password', async () => {
    const directory = new MemoryUserDirectory();
    directory.failAddFor = 'fsk-owner';
    let caught: unknown;
    try {
      await provisionCognitoUsers({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-USERS-5',
        ownerUsername: 'fsk-owner',
        kitchenUsername: 'fsk-kitchen',
        environment: {
          FSK_OWNER_TEMP_PASSWORD: 'Owner-Temporary-Secret1!',
          FSK_KITCHEN_TEMP_PASSWORD: 'Kitchen-Temporary-Secret1!',
        },
        safety: new FakeSafety(),
        directory,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'COGNITO_PROVISION_PARTIAL_FAILURE',
      username: 'fsk-owner',
      userCreation: 'confirmed',
      groupMembership: 'unknown',
    });
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain('Owner-Temporary-Secret1!');
    expect(serialized).not.toContain('Kitchen-Temporary-Secret1!');
    expect(String(caught)).not.toMatch(/Temporary-Secret|password/i);
  });

  it('marks a failed create response as outcome unknown instead of claiming no user exists', async () => {
    const directory = new MemoryUserDirectory();
    directory.failCreateFor = 'fsk-owner';
    let caught: unknown;
    try {
      await provisionCognitoUsers({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-USERS-6',
        ownerUsername: 'fsk-owner',
        kitchenUsername: 'fsk-kitchen',
        environment: {
          FSK_OWNER_TEMP_PASSWORD: 'Owner-Temporary-Secret1!',
          FSK_KITCHEN_TEMP_PASSWORD: 'Kitchen-Temporary-Secret1!',
        },
        safety: new FakeSafety(),
        directory,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'COGNITO_PROVISION_PARTIAL_FAILURE',
      username: 'fsk-owner',
      userCreation: 'unknown',
      groupMembership: 'not-attempted',
      failureCode: 'SYNTHETIC_CREATE_UNKNOWN',
    });
    expect(JSON.stringify(caught)).not.toMatch(/Temporary-Secret|password/i);
  });
});

describe('Cognito AWS adapter and CLI', () => {
  it('reports a sanitized partial outcome instead of hiding ambiguous AWS state', () => {
    const error = new CognitoProvisionPartialError(
      'fsk-owner',
      'unknown',
      'not-attempted',
      'UNCLASSIFIED_COGNITO_FAILURE',
    );
    expect(formatProvisionUsersCliError(error)).toEqual({
      code: 'COGNITO_PROVISION_PARTIAL_FAILURE',
      username: 'fsk-owner',
      userCreation: 'unknown',
      groupMembership: 'not-attempted',
      failureCode: 'UNCLASSIFIED_COGNITO_FAILURE',
    });
  });

  it('sends username-only create input with no contact, legacy role, or hash attributes', async () => {
    const commands: Array<{ input?: Record<string, unknown> }> = [];
    const client = {
      async send(command: { input?: Record<string, unknown> }): Promise<Record<string, unknown>> {
        commands.push(command);
        if (commands.length === 1) {
          const error = new Error('not found');
          error.name = 'UserNotFoundException';
          throw error;
        }
        return {};
      },
    };
    const directory = new AwsCognitoUserDirectory(
      'ap-northeast-1_FSK123',
      client,
    );
    expect(await directory.getUser('fsk-owner')).toBeNull();
    await directory.createUser('fsk-owner', 'Synthetic-Secret1!');
    await directory.addUserToGroup('fsk-owner', 'OWNER');

    expect(commands[1].input).toEqual({
      UserPoolId: 'ap-northeast-1_FSK123',
      Username: 'fsk-owner',
      TemporaryPassword: 'Synthetic-Secret1!',
      MessageAction: 'SUPPRESS',
      UserAttributes: [],
    });
    expect(JSON.stringify(commands[1].input)).not.toMatch(
      /email|phone|bcrypt|hash|WEBMASTER|ADMIN/,
    );
    expect(commands[2].input).toEqual({
      UserPoolId: 'ap-northeast-1_FSK123',
      Username: 'fsk-owner',
      GroupName: 'OWNER',
    });
  });

  it('rejects every existing user attribute except Cognito sub before checking groups', async () => {
    const commands: Array<{ input?: Record<string, unknown> }> = [];
    const directory = new AwsCognitoUserDirectory(
      'ap-northeast-1_FSK123',
      {
        async send(command) {
          commands.push(command);
          return {
            Username: 'fsk-owner',
            UserAttributes: [
              { Name: 'sub', Value: 'synthetic-sub' },
              { Name: 'custom:legacyIdentity', Value: 'legacy-value' },
            ],
          };
        },
      },
    );
    await expect(directory.getUser('fsk-owner')).rejects.toThrow(
      'COGNITO_USER_ATTRIBUTE_CONFLICT:fsk-owner',
    );
    expect(commands).toHaveLength(1);
  });

  it.each([
    { argv: [], mode: 'dry-run', error: null },
    { argv: ['--apply'], error: 'PROVISION_APPROVAL_ID_REQUIRED' },
    {
      argv: ['--apply', '--approval-id', 'FSK-1'],
      error: 'PROVISION_TARGET_CONFIG_REQUIRED',
    },
    {
      argv: ['--password', 'forbidden'],
      error: 'PROVISION_FORBIDDEN_ARGUMENT',
    },
    {
      argv: ['--role', 'WEBMASTER'],
      error: 'PROVISION_FORBIDDEN_ARGUMENT',
    },
    {
      argv: ['--email', 'owner@example.invalid'],
      error: 'PROVISION_FORBIDDEN_ARGUMENT',
    },
  ])('defaults dry-run and rejects unsafe CLI inputs: $argv', ({ argv, mode, error }) => {
    if (error) {
      expect(() => parseProvisionUsersCliOptions(argv)).toThrow(error);
    } else {
      expect(parseProvisionUsersCliOptions(argv).mode).toBe(mode);
    }
  });
});
