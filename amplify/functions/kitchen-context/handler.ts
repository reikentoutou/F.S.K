interface StringAttribute {
  readonly S?: string;
}

interface NumberAttribute {
  readonly N?: string;
}

interface BooleanAttribute {
  readonly BOOL?: boolean;
}

type AttributeValue = StringAttribute & NumberAttribute & BooleanAttribute;
type Item = Record<string, AttributeValue>;

export interface KitchenContextResult {
  registerFloatAmount: number;
  shifts: Array<{ id: string; name: string; sortOrder: number }>;
  responsiblePersons: Array<{ id: string; name: string }>;
  submittedShiftIds: string[];
}

interface ReadCommand {
  readonly operation: 'GetItem' | 'Query' | 'Scan';
  readonly input: Record<string, unknown>;
}

interface ReadResponse {
  readonly Item?: Item;
  readonly Items?: Item[];
  readonly LastEvaluatedKey?: Item;
}

export interface KitchenContextInput {
  readonly tableNames: {
    readonly appSetting: string;
    readonly dailyReport: string;
    readonly shiftDefinition: string;
    readonly responsiblePerson: string;
  };
  readonly businessDate: string;
  send(command: ReadCommand): Promise<unknown>;
}

const requiredString = (item: Item, field: string): string => {
  const value = item[field]?.S;
  if (value === undefined) {
    throw new Error(`INVALID_KITCHEN_CONTEXT_FIELD:${field}`);
  }
  return value;
};

const requiredInteger = (item: Item, field: string): number => {
  const value = Number(item[field]?.N);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`INVALID_KITCHEN_CONTEXT_FIELD:${field}`);
  }
  return value;
};

const isActive = (item: Item): boolean => item.active?.BOOL === true;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const tokyoBusinessDate = (now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (!value) throw new Error('KITCHEN_BUSINESS_DATE_NOT_ALLOWED');
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export const resolveKitchenBusinessDate = (
  value: string | null | undefined,
  now = new Date(),
): string => {
  const currentBusinessDate = tokyoBusinessDate(now);
  const businessDate = value ?? currentBusinessDate;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    ? new Date(`${businessDate}T00:00:00.000Z`)
    : null;
  if (
    parsed === null ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== businessDate ||
    businessDate > currentBusinessDate
  ) {
    throw new Error('KITCHEN_BUSINESS_DATE_NOT_ALLOWED');
  }
  return businessDate;
};

const scanAll = async (
  send: KitchenContextInput['send'],
  input: Record<string, unknown>,
): Promise<Item[]> => {
  const items: Item[] = [];
  let exclusiveStartKey: Item | undefined;
  do {
    const response = (await send({
      operation: 'Scan',
      input: exclusiveStartKey
        ? { ...input, ExclusiveStartKey: exclusiveStartKey }
        : input,
    })) as ReadResponse;
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

export async function loadKitchenContext({
  tableNames,
  businessDate,
  send,
}: KitchenContextInput): Promise<KitchenContextResult> {
  const settingResponse = (await send({
    operation: 'GetItem',
    input: {
      Key: { id: { S: 'default' } },
      ProjectionExpression: 'registerFloatAmount',
      TableName: tableNames.appSetting,
    },
  })) as ReadResponse;
  if (!settingResponse.Item) {
    throw new Error('KITCHEN_CONTEXT_SETTING_NOT_FOUND');
  }

  const [shiftItems, responsiblePersonItems] = await Promise.all([
    scanAll(send, {
      ExpressionAttributeNames: { '#active': 'active', '#name': 'name' },
      ExpressionAttributeValues: { ':active': { BOOL: true } },
      FilterExpression: '#active = :active',
      ProjectionExpression: 'id, #name, sortOrder, #active',
      TableName: tableNames.shiftDefinition,
    }),
    scanAll(send, {
      ExpressionAttributeNames: { '#active': 'active', '#name': 'name' },
      ExpressionAttributeValues: { ':active': { BOOL: true } },
      FilterExpression: '#active = :active',
      ProjectionExpression: 'id, #name, #active',
      TableName: tableNames.responsiblePerson,
    }),
  ]);

  const shifts = shiftItems
    .filter(isActive)
    .map((item) => ({
      id: requiredString(item, 'id'),
      name: requiredString(item, 'name'),
      sortOrder: requiredInteger(item, 'sortOrder'),
    }))
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || compareText(left.id, right.id),
    );
  const submitted = await Promise.all(
    shifts.map(async (shift) => {
      const response = (await send({
        operation: 'GetItem',
        input: {
          ConsistentRead: true,
          Key: { reportKey: { S: `${businessDate}#${shift.id}` } },
          ProjectionExpression: 'reportKey',
          TableName: tableNames.dailyReport,
        },
      })) as ReadResponse;
      return response.Item ? shift.id : null;
    }),
  );

  return {
    registerFloatAmount: requiredInteger(
      settingResponse.Item,
      'registerFloatAmount',
    ),
    shifts,
    responsiblePersons: responsiblePersonItems
      .filter(isActive)
      .map((item) => ({
        id: requiredString(item, 'id'),
        name: requiredString(item, 'name'),
      }))
      .sort(
        (left, right) =>
          compareText(left.name, right.name) || compareText(left.id, right.id),
      ),
    submittedShiftIds: submitted.filter(
      (shiftId): shiftId is string => shiftId !== null,
    ),
  };
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`MISSING_KITCHEN_CONTEXT_ENVIRONMENT:${name}`);
  }
  return value;
};

interface DynamoDbSdk {
  DynamoDBClient: new (input: Record<string, never>) => {
    send(command: unknown): Promise<unknown>;
  };
  GetItemCommand: new (input: Record<string, unknown>) => unknown;
  QueryCommand: new (input: Record<string, unknown>) => unknown;
  ScanCommand: new (input: Record<string, unknown>) => unknown;
}

export const handler = async (event: {
  arguments: { businessDate?: string | null };
}): Promise<KitchenContextResult> => {
  // Lambda Node.js runtimes provide AWS SDK v3. Keeping the module name dynamic
  // prevents bundling a second SDK copy into this small read-only function.
  const sdkModuleName = '@aws-sdk/client-dynamodb';
  const sdk = (await import(sdkModuleName)) as DynamoDbSdk;
  const client = new sdk.DynamoDBClient({});
  return loadKitchenContext({
    tableNames: {
      appSetting: requiredEnvironment('APP_SETTING_TABLE_NAME'),
      dailyReport: requiredEnvironment('DAILY_REPORT_TABLE_NAME'),
      shiftDefinition: requiredEnvironment('SHIFT_DEFINITION_TABLE_NAME'),
      responsiblePerson: requiredEnvironment('RESPONSIBLE_PERSON_TABLE_NAME'),
    },
    businessDate: resolveKitchenBusinessDate(event.arguments.businessDate),
    send({ operation, input }) {
      const Command =
        operation === 'GetItem'
          ? sdk.GetItemCommand
          : operation === 'Query'
            ? sdk.QueryCommand
            : sdk.ScanCommand;
      return client.send(new Command(input));
    },
  });
};
