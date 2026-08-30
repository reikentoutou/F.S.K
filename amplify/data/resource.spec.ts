import { beforeAll, describe, expect, it } from 'vitest';

interface DataResourceModule {
  readonly schema: {
    transform(): { schema: string };
  };
}

let resourceModule: DataResourceModule | undefined;
let resourceLoadError: unknown;

beforeAll(async () => {
  try {
    resourceModule = (await import('./resource.js')) as DataResourceModule;
  } catch (error) {
    resourceLoadError = error;
  }
});

const transformedSchema = (): string => {
  expect(resourceLoadError).toBeUndefined();
  expect(resourceModule).toBeDefined();
  return resourceModule?.schema.transform().schema ?? '';
};

const modelDefinition = (
  schema: string,
  modelName: string,
): { directives: string; fields: string[] } => {
  const match = schema.match(
    new RegExp(`^type ${modelName} ([\\s\\S]*?)\\n\\{\\n([\\s\\S]*?)^\\}`, 'm'),
  );
  expect(match, `missing transformed model ${modelName}`).not.toBeNull();
  return {
    directives: match?.[1].replace(/\s+/g, ' ').trim() ?? '',
    fields:
      match?.[2]
        .split('\n')
        .map((field) => field.trim())
        .filter(Boolean) ?? [],
  };
};

describe('Amplify Data schema contract', () => {
  it('transforms exactly the four DynamoDB business models and their fields', () => {
    const output = transformedSchema();
    expect([...output.matchAll(/^type (\w+) @model/gm)].map(([, name]) => name)).toEqual([
      'DailyReport',
      'ShiftDefinition',
      'ResponsiblePerson',
      'AppSetting',
    ]);

    expect(modelDefinition(output, 'DailyReport').fields).toEqual([
      'reportKey: ID! @primaryKey',
      'businessDate: String! @index(sortKeyFields: ["shiftId"], queryField: "dailyReportsByBusinessDate")',
      'shiftId: ID!',
      'shiftNameSnapshot: String!',
      'responsiblePersonId: ID!',
      'responsiblePersonSnapshot: String!',
      'startMinuteOfDay: Int!',
      'endMinuteOfDay: Int!',
      'timeRangeLabelSnapshot: String!',
      'previousImosBalanceYen: Int!',
      'currentImosBalanceYen: Int!',
      'newageYen: Int!',
      'cashTotalYen: Int!',
      'expenseYen: Int!',
      'expenseReason: String',
      'staffMealCashYen: Int!',
      'staffMealAlipayYen: Int!',
      'attachmentKeys: [String]',
      'submittedAt: AWSDateTime!',
      'legacySubmittedByUsername: String',
    ]);
    expect(modelDefinition(output, 'ShiftDefinition').fields).toEqual([
      'id: ID! @primaryKey',
      'name: String!',
      'sortOrder: Int!',
      'active: Boolean!',
    ]);
    expect(modelDefinition(output, 'ResponsiblePerson').fields).toEqual([
      'id: ID! @primaryKey',
      'name: String!',
      'active: Boolean!',
    ]);
    expect(modelDefinition(output, 'AppSetting').fields).toEqual([
      'id: ID! @primaryKey',
      'registerFloatAmount: Int!',
      'setupCompleted: Boolean!',
    ]);
  });

  it('uses reportKey as the identifier and exposes the daily composite query', () => {
    const dailyReport = modelDefinition(transformedSchema(), 'DailyReport');
    expect(dailyReport.fields).toContain('reportKey: ID! @primaryKey');
    expect(dailyReport.fields).toContain(
      'businessDate: String! @index(sortKeyFields: ["shiftId"], queryField: "dailyReportsByBusinessDate")',
    );
  });

  it('keeps every persisted yen amount as a required integer', () => {
    const dailyReport = modelDefinition(transformedSchema(), 'DailyReport');
    const amountFields = [
      'previousImosBalanceYen',
      'currentImosBalanceYen',
      'newageYen',
      'cashTotalYen',
      'expenseYen',
      'staffMealCashYen',
      'staffMealAlipayYen',
    ];
    for (const field of amountFields) {
      expect(dailyReport.fields).toContain(`${field}: Int!`);
    }
    expect(modelDefinition(transformedSchema(), 'AppSetting').fields).toContain(
      'registerFloatAmount: Int!',
    );
  });

  it('transforms the exact OWNER and KITCHEN authorization matrix', () => {
    const output = transformedSchema();
    expect(modelDefinition(output, 'DailyReport').directives).toBe(
      '@model @auth(rules: [{allow: groups, groups: ["OWNER"]}, {allow: owner, operations: [create], ownerField: "owner"}])',
    );
    for (const modelName of ['ShiftDefinition', 'ResponsiblePerson']) {
      expect(modelDefinition(output, modelName).directives).toBe(
        '@model @auth(rules: [{allow: groups, groups: ["OWNER"]}, {allow: groups, operations: [read], groups: ["KITCHEN"]}])',
      );
    }
    expect(modelDefinition(output, 'AppSetting').directives).toBe(
      '@model @auth(rules: [{allow: groups, groups: ["OWNER"]}])',
    );
  });

  it('exposes only submitted shift ids in the dated kitchen context query', () => {
    const output = transformedSchema();

    expect(output).toContain('submittedShiftIds: [ID]!');
    expect(output).toContain(
      'getKitchenContext(businessDate: String): KitchenContext',
    );
    expect(output).not.toMatch(/type KitchenContext[\s\S]*cashTotalYen/);
  });
});
