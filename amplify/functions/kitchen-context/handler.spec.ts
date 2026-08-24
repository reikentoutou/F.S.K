import { beforeAll, describe, expect, it } from 'vitest';

interface KitchenContextResult {
  registerFloatAmount: number;
  shifts: Array<{ id: string; name: string; sortOrder: number }>;
  responsiblePersons: Array<{ id: string; name: string }>;
}

interface KitchenContextModule {
  loadKitchenContext(input: {
    tableNames: {
      appSetting: string;
      shiftDefinition: string;
      responsiblePerson: string;
    };
    send(command: {
      operation: 'GetItem' | 'Query' | 'Scan';
      input: unknown;
    }): Promise<unknown>;
  }): Promise<KitchenContextResult>;
}

let kitchenContextModule: KitchenContextModule | undefined;
let kitchenContextLoadError: unknown;

beforeAll(async () => {
  try {
    kitchenContextModule = (await import('./handler.js')) as KitchenContextModule;
  } catch (error) {
    kitchenContextLoadError = error;
  }
});

describe('getKitchenContext', () => {
  it('returns only register float and active, sorted fill-in options', async () => {
    expect(kitchenContextLoadError).toBeUndefined();
    expect(kitchenContextModule).toBeDefined();

    const responses = [
      {
        Item: {
          id: { S: 'default' },
          registerFloatAmount: { N: '5000' },
          setupCompleted: { BOOL: true },
          internalNote: { S: 'must-not-leak' },
        },
      },
      {
        Items: [
          { id: { S: 'night' }, name: { S: '夜班' }, sortOrder: { N: '20' }, active: { BOOL: true } },
          { id: { S: 'disabled' }, name: { S: '停用' }, sortOrder: { N: '0' }, active: { BOOL: false } },
          { id: { S: 'day' }, name: { S: '日班' }, sortOrder: { N: '10' }, active: { BOOL: true } },
        ],
      },
      {
        Items: [
          { id: { S: 'p2' }, name: { S: '李四' }, active: { BOOL: true } },
          { id: { S: 'hidden' }, name: { S: '停用人' }, active: { BOOL: false } },
          { id: { S: 'p1' }, name: { S: '张三' }, active: { BOOL: true } },
        ],
      },
    ];
    const commands: unknown[] = [];

    const result = await kitchenContextModule!.loadKitchenContext({
      tableNames: {
        appSetting: 'app-setting-table',
        shiftDefinition: 'shift-table',
        responsiblePerson: 'person-table',
      },
      async send(command) {
        commands.push(command);
        return responses[commands.length - 1];
      },
    });

    expect(result).toEqual({
      registerFloatAmount: 5000,
      shifts: [
        { id: 'day', name: '日班', sortOrder: 10 },
        { id: 'night', name: '夜班', sortOrder: 20 },
      ],
      responsiblePersons: [
        { id: 'p1', name: '张三' },
        { id: 'p2', name: '李四' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('setupCompleted');
    expect(JSON.stringify(result)).not.toContain('internalNote');
    expect(JSON.stringify(result)).not.toContain('DailyReport');
    expect(JSON.stringify(result)).not.toContain('attachment');
    expect(commands).toHaveLength(3);
    expect(commands).toEqual([
      {
        operation: 'GetItem',
        input: {
          Key: { id: { S: 'default' } },
          ProjectionExpression: 'registerFloatAmount',
          TableName: 'app-setting-table',
        },
      },
      {
        operation: 'Scan',
        input: {
          ExpressionAttributeValues: { ':active': { BOOL: true } },
          FilterExpression: '#active = :active',
          ProjectionExpression: 'id, #name, sortOrder, #active',
          ExpressionAttributeNames: { '#active': 'active', '#name': 'name' },
          TableName: 'shift-table',
        },
      },
      {
        operation: 'Scan',
        input: {
          ExpressionAttributeNames: { '#active': 'active', '#name': 'name' },
          ExpressionAttributeValues: { ':active': { BOOL: true } },
          FilterExpression: '#active = :active',
          ProjectionExpression: 'id, #name, #active',
          TableName: 'person-table',
        },
      },
    ]);
  });
});
