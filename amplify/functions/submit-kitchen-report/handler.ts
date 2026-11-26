import { assertDailyReportRawAmounts } from '../../../packages/domain/src/daily-report.js';
import { resolveStoreAccess, storeReportKey } from '../../../packages/domain/src/stores.js';
import { loadKitchenContext, resolveKitchenBusinessDate, type KitchenContextResult } from '../kitchen-context/handler.js';

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length > 2000) throw new Error('INVALID_REPORT');
  return value;
}
function integer(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('INVALID_REPORT');
  return value;
}

export function prepareKitchenReport(input: Record<string, unknown>, claims: Record<string, unknown>, context: KitchenContextResult, now = new Date()) {
  const storeId = resolveStoreAccess(claims, text(input, 'storeId'));
  const businessDate = resolveKitchenBusinessDate(text(input, 'businessDate'), now);
  const shiftId = text(input, 'shiftId');
  const personId = text(input, 'responsiblePersonId');
  const shift = context.shifts.find((candidate) => candidate.id === shiftId);
  const person = context.responsiblePersons.find((candidate) => candidate.id === personId);
  if (!shift || !person) throw new Error('STORE_RESOURCE_NOT_FOUND');
  if (context.submittedShiftIds.includes(shiftId)) throw new Error('REPORT_ALREADY_EXISTS');
  const amounts = {
    previousImosBalanceYen: integer(input, 'previousImosBalanceYen'),
    currentImosBalanceYen: integer(input, 'currentImosBalanceYen'),
    newageYen: integer(input, 'newageYen'),
    cashTotalYen: integer(input, 'cashTotalYen'),
    expenseYen: integer(input, 'expenseYen'),
    staffMealCashYen: integer(input, 'staffMealCashYen'),
    staffMealAlipayYen: integer(input, 'staffMealAlipayYen'),
  };
  assertDailyReportRawAmounts(amounts);
  const startMinuteOfDay = integer(input, 'startMinuteOfDay');
  const endMinuteOfDay = integer(input, 'endMinuteOfDay');
  if ([startMinuteOfDay, endMinuteOfDay].some((minute) => minute < 0 || minute > 1439)) throw new Error('INVALID_REPORT_TIME');
  const attachmentKeys = input.attachmentKeys;
  if (!Array.isArray(attachmentKeys) || attachmentKeys.length > 10 || !attachmentKeys.every((key): key is string => typeof key === 'string' && key.length < 1024)) throw new Error('INVALID_ATTACHMENTS');
  const expenseReason = typeof input.expenseReason === 'string' ? input.expenseReason.trim() : '';
  if (expenseReason.length > 2000 || (amounts.expenseYen > 0 && (!expenseReason || !attachmentKeys.length))) throw new Error('EXPENSE_RECEIPT_REQUIRED');
  const subject = text(claims, 'sub');
  const username = text(claims, 'cognito:username');
  const hm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return {
    reportKey: storeReportKey(storeId, businessDate, shiftId), storeId, businessDate,
    shiftId, shiftNameSnapshot: shift.name,
    responsiblePersonId: personId, responsiblePersonSnapshot: person.name,
    startMinuteOfDay, endMinuteOfDay, timeRangeLabelSnapshot: `${hm(startMinuteOfDay)}–${hm(endMinuteOfDay)}`,
    ...amounts, expenseReason, attachmentKeys,
    registerFloatSnapshot: context.registerFloatAmount,
    owner: `${subject}::${username}`, submittedAt: now.toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENVIRONMENT:${name}`);
  return value;
}
interface AwsClient { send(command: unknown): Promise<Record<string, unknown>> }
type Command = new (input: Record<string, unknown>) => unknown;
interface DynamoSdk {
  DynamoDBClient: new (input: Record<string, never>) => AwsClient;
  GetItemCommand: Command; ScanCommand: Command; QueryCommand: Command; PutItemCommand: Command;
}

export const handler = async (event: {
  arguments: { input: unknown };
  identity?: { claims?: Record<string, unknown> };
  request?: { headers?: Record<string, string> };
}) => {
  const raw: unknown = typeof event.arguments.input === 'string' ? JSON.parse(event.arguments.input) : event.arguments.input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_REPORT');
  const input = raw as Record<string, unknown>;
  const claims = event.identity?.claims ?? {};
  const storeId = resolveStoreAccess(claims, text(input, 'storeId'));
  const date = resolveKitchenBusinessDate(text(input, 'businessDate'));
  const sdkName = '@aws-sdk/client-dynamodb';
  const sdk = await import(sdkName) as DynamoSdk;
  const client = new sdk.DynamoDBClient({});
  const context = await loadKitchenContext({
    storeId, businessDate: date,
    tableNames: { appSetting: env('APP_SETTING_TABLE_NAME'), dailyReport: env('DAILY_REPORT_TABLE_NAME'), shiftDefinition: env('SHIFT_DEFINITION_TABLE_NAME'), responsiblePerson: env('RESPONSIBLE_PERSON_TABLE_NAME') },
    send({ operation, input: readInput }) {
      const ReadCommand = sdk[`${operation}Command`];
      return client.send(new ReadCommand(readInput));
    },
  });
  const report = prepareKitchenReport(input, claims, context);
  if (report.attachmentKeys.length) {
    const identityModule = '@aws-sdk/client-cognito-identity';
    const identitySdk = await import(identityModule) as { CognitoIdentityClient: new (input: Record<string, never>) => AwsClient; GetIdCommand: Command };
    const authorization = event.request?.headers?.authorization ?? event.request?.headers?.Authorization;
    if (!authorization) throw new Error('ATTACHMENT_FORBIDDEN');
    const identity = await new identitySdk.CognitoIdentityClient({}).send(new identitySdk.GetIdCommand({
      IdentityPoolId: env('IDENTITY_POOL_ID'),
      Logins: { [`cognito-idp.${env('AWS_REGION')}.amazonaws.com/${env('USER_POOL_ID')}`]: authorization.replace(/^Bearer /i, '') },
    }));
    if (typeof identity.IdentityId !== 'string') throw new Error('ATTACHMENT_FORBIDDEN');
    const s3Module = '@aws-sdk/client-s3';
    const s3 = await import(s3Module) as { S3Client: new (input: Record<string, never>) => AwsClient; HeadObjectCommand: Command };
    const storage = new s3.S3Client({});
    for (const key of report.attachmentKeys) {
      if (!key.startsWith(`submissions/${identity.IdentityId}/`) || key.split('/').length !== 5 || key.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('ATTACHMENT_FORBIDDEN');
      await storage.send(new s3.HeadObjectCommand({ Bucket: env('STORAGE_BUCKET_NAME'), Key: key }));
    }
  }
  const Item = Object.fromEntries(Object.entries(report).map(([key, value]) => [key,
    typeof value === 'number' ? { N: String(value) } : Array.isArray(value) ? { L: value.map((entry) => ({ S: entry })) } : { S: value },
  ]));
  try {
    await client.send(new sdk.PutItemCommand({ TableName: env('DAILY_REPORT_TABLE_NAME'), Item, ConditionExpression: 'attribute_not_exists(reportKey)' }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new Error('REPORT_ALREADY_EXISTS');
    throw error;
  }
  return { reportKey: report.reportKey, submittedAt: report.submittedAt, registerFloatSnapshot: report.registerFloatSnapshot, shiftNameSnapshot: report.shiftNameSnapshot, responsiblePersonSnapshot: report.responsiblePersonSnapshot };
};
