import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  AmplifyClient,
  GetAppCommand,
} from '@aws-sdk/client-amplify';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListGroupsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTagsOfResourceCommand as ListDynamoTagsCommand,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { AttachmentManifestEntry } from './contracts';

export const TARGET_MODEL_ORDER = [
  'ShiftDefinition',
  'ResponsiblePerson',
  'AppSetting',
  'DailyReport',
] as const;

export type MigrationModelName = (typeof TARGET_MODEL_ORDER)[number];

export interface MigrationTarget {
  assertSafeTarget(): Promise<void>;
  putRecord(
    model: MigrationModelName,
    key: string,
    record: Record<string, unknown>,
  ): Promise<'created' | 'unchanged'>;
  putAttachment(
    entry: AttachmentManifestEntry,
    sourcePath: string,
  ): Promise<'created' | 'unchanged'>;
  listRecords(model: MigrationModelName): Promise<Record<string, unknown>[]>;
  readAttachment(objectKey: string): Promise<{ byteSize: number; sha256: string }>;
}

interface NamedResource {
  name: string;
  arn: string;
  stackName: string;
}

export interface TargetConfiguration {
  accountId: string;
  region: string;
  amplifyApp: { appId: string; name: string };
  stacks: Record<'auth' | 'data' | 'storage' | 'function', { name: string; arn: string }>;
  tables: Record<MigrationModelName, NamedResource>;
  bucket: NamedResource;
  userPool: { id: string; arn: string; stackName: string };
}

interface CommandClient {
  send(command: { input?: Record<string, unknown> }): Promise<unknown>;
}

export interface AwsMigrationClients {
  sts: CommandClient;
  amplify: CommandClient;
  cloudFormation: CommandClient;
  dynamo: CommandClient;
  s3: CommandClient;
  cognito: CommandClient;
}

const EXPECTED_ACCOUNT_ID = '444083008754';
const EXPECTED_REGION = 'ap-northeast-1';
const EXPECTED_APP_NAME = 'FSK';
const REQUIRED_TAGS = {
  Project: 'FSK',
  Environment: 'production',
  ManagedBy: 'AmplifyGen2',
  CostCenter: 'FSK',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(code);
  }
}

function rejectGameList(value: unknown): void {
  if (JSON.stringify(value).toLowerCase().includes('gamelist')) {
    throw new Error('TARGET_GAMELIST_FORBIDDEN');
  }
}

function assertArn(
  arn: string,
  service: string,
  region: string | null,
  accountId: string | null,
): void {
  const parts = arn.split(':');
  if (
    parts.length < 6 ||
    parts[0] !== 'arn' ||
    parts[1] !== 'aws' ||
    parts[2] !== service ||
    (region !== null && parts[3] !== region) ||
    (accountId !== null && parts[4] !== accountId)
  ) {
    throw new Error(`TARGET_CONFIG_ARN_INVALID:${service}`);
  }
}

export function assertExplicitTargetConfiguration(value: unknown): asserts value is TargetConfiguration {
  if (!isRecord(value)) throw new Error('TARGET_CONFIG_INVALID');
  assertExactKeys(
    value,
    ['accountId', 'region', 'amplifyApp', 'stacks', 'tables', 'bucket', 'userPool'],
    'TARGET_CONFIG_UNKNOWN_FIELD',
  );
  rejectGameList(value);
  if (value.accountId !== EXPECTED_ACCOUNT_ID) throw new Error('TARGET_ACCOUNT_INVALID');
  if (value.region !== EXPECTED_REGION) throw new Error('TARGET_REGION_INVALID');
  if (!isRecord(value.amplifyApp)) throw new Error('TARGET_CONFIG_APP_REQUIRED');
  assertExactKeys(value.amplifyApp, ['appId', 'name'], 'TARGET_CONFIG_APP_UNKNOWN_FIELD');
  const appId = requiredText(value.amplifyApp.appId, 'TARGET_CONFIG_APP_REQUIRED');
  if (value.amplifyApp.name !== EXPECTED_APP_NAME) {
    throw new Error('TARGET_CONFIG_APP_INVALID');
  }
  if (!/^[a-z0-9]+$/u.test(appId)) throw new Error('TARGET_CONFIG_APP_INVALID');

  if (!isRecord(value.stacks) || Object.keys(value.stacks).sort().join(',') !== 'auth,data,function,storage') {
    throw new Error('TARGET_CONFIG_STACKS_REQUIRED');
  }
  const stackNames = new Set<string>();
  for (const role of ['auth', 'data', 'storage', 'function'] as const) {
    const stack = value.stacks[role];
    if (!isRecord(stack)) throw new Error(`TARGET_CONFIG_STACK_REQUIRED:${role}`);
    assertExactKeys(stack, ['name', 'arn'], `TARGET_CONFIG_STACK_UNKNOWN_FIELD:${role}`);
    const name = requiredText(stack.name, `TARGET_CONFIG_STACK_REQUIRED:${role}`);
    const arn = requiredText(stack.arn, `TARGET_CONFIG_STACK_REQUIRED:${role}`);
    assertArn(arn, 'cloudformation', EXPECTED_REGION, EXPECTED_ACCOUNT_ID);
    if (!name.toLowerCase().includes(appId)) {
      throw new Error(`TARGET_CONFIG_STACK_APP_MISMATCH:${role}`);
    }
    if (stackNames.has(name)) throw new Error('TARGET_CONFIG_STACK_DUPLICATE');
    stackNames.add(name);
  }
  const stacks = value.stacks as unknown as TargetConfiguration['stacks'];

  if (!isRecord(value.tables) || Object.keys(value.tables).sort().join(',') !== [...TARGET_MODEL_ORDER].sort().join(',')) {
    throw new Error('TARGET_CONFIG_TABLES_REQUIRED');
  }
  for (const model of TARGET_MODEL_ORDER) {
    const table = value.tables[model];
    if (!isRecord(table)) throw new Error(`TARGET_CONFIG_TABLE_REQUIRED:${model}`);
    assertExactKeys(table, ['name', 'arn', 'stackName'], `TARGET_CONFIG_TABLE_UNKNOWN_FIELD:${model}`);
    const name = requiredText(table.name, `TARGET_CONFIG_TABLE_REQUIRED:${model}`);
    const arn = requiredText(table.arn, `TARGET_CONFIG_TABLE_REQUIRED:${model}`);
    const stackName = requiredText(table.stackName, `TARGET_CONFIG_TABLE_REQUIRED:${model}`);
    assertArn(arn, 'dynamodb', EXPECTED_REGION, EXPECTED_ACCOUNT_ID);
    if (!arn.endsWith(`/table/${name}`) && !arn.endsWith(`:table/${name}`)) {
      throw new Error(`TARGET_CONFIG_TABLE_ARN_MISMATCH:${model}`);
    }
    if (stackName !== stacks.data.name) {
      throw new Error(`TARGET_CONFIG_TABLE_STACK_MISMATCH:${model}`);
    }
  }

  if (!isRecord(value.bucket)) throw new Error('TARGET_CONFIG_BUCKET_REQUIRED');
  assertExactKeys(value.bucket, ['name', 'arn', 'stackName'], 'TARGET_CONFIG_BUCKET_UNKNOWN_FIELD');
  const bucketName = requiredText(value.bucket.name, 'TARGET_CONFIG_BUCKET_REQUIRED');
  const bucketArn = requiredText(value.bucket.arn, 'TARGET_CONFIG_BUCKET_REQUIRED');
  if (bucketArn !== `arn:aws:s3:::${bucketName}`) throw new Error('TARGET_CONFIG_BUCKET_ARN_MISMATCH');
  if (value.bucket.stackName !== stacks.storage.name) {
    throw new Error('TARGET_CONFIG_BUCKET_STACK_MISMATCH');
  }

  if (!isRecord(value.userPool)) throw new Error('TARGET_CONFIG_USER_POOL_REQUIRED');
  assertExactKeys(value.userPool, ['id', 'arn', 'stackName'], 'TARGET_CONFIG_USER_POOL_UNKNOWN_FIELD');
  const poolId = requiredText(value.userPool.id, 'TARGET_CONFIG_USER_POOL_REQUIRED');
  const poolArn = requiredText(value.userPool.arn, 'TARGET_CONFIG_USER_POOL_REQUIRED');
  assertArn(poolArn, 'cognito-idp', EXPECTED_REGION, EXPECTED_ACCOUNT_ID);
  if (!poolArn.endsWith(`/userpool/${poolId}`) && !poolArn.endsWith(`:userpool/${poolId}`)) {
    throw new Error('TARGET_CONFIG_USER_POOL_ARN_MISMATCH');
  }
  if (value.userPool.stackName !== stacks.auth.name) {
    throw new Error('TARGET_CONFIG_USER_POOL_STACK_MISMATCH');
  }
}

function tagsFromArray(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value
      .filter((entry): entry is { Key: string; Value: string } =>
        isRecord(entry) && typeof entry.Key === 'string' && typeof entry.Value === 'string')
      .map(({ Key, Value }) => [Key, Value]),
  );
}

function assertRequiredTags(tags: unknown, resource: string): void {
  const actual = Array.isArray(tags) ? tagsFromArray(tags) : tags;
  if (!isRecord(actual)) throw new Error(`TARGET_TAGS_INVALID:${resource}`);
  for (const [key, value] of Object.entries(REQUIRED_TAGS)) {
    if (actual[key] !== value) throw new Error(`TARGET_TAG_MISMATCH:${resource}:${key}`);
  }
  if (Object.values(actual).some((value) => String(value).toLowerCase().includes('gamelist'))) {
    throw new Error(`TARGET_GAMELIST_FORBIDDEN:${resource}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('TARGET_RECORD_NUMBER_INVALID');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new Error('TARGET_RECORD_VALUE_INVALID');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function marshalValue(value: unknown): AttributeValue {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(marshalValue) };
  if (isRecord(value)) return { M: marshalRecord(value) };
  throw new Error('TARGET_RECORD_VALUE_INVALID');
}

function marshalRecord(value: Record<string, unknown>): Record<string, AttributeValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, marshalValue(entry)]),
  );
}

function unmarshalValue(value: AttributeValue): unknown {
  if ('S' in value) return value.S;
  if ('N' in value) {
    const number = Number(value.N);
    if (!Number.isSafeInteger(number)) throw new Error('TARGET_RECORD_NUMBER_INVALID');
    return number;
  }
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('L' in value) return (value.L ?? []).map(unmarshalValue);
  if ('M' in value) return unmarshalRecord(value.M ?? {});
  throw new Error('TARGET_RECORD_VALUE_INVALID');
}

function unmarshalRecord(value: Record<string, AttributeValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unmarshalValue(entry)]));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function isMissingObject(error: unknown): boolean {
  return ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(errorName(error));
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (isRecord(body) && typeof body.transformToByteArray === 'function') {
    return (await (body.transformToByteArray as () => Promise<Uint8Array>)());
  }
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  throw new Error('TARGET_ATTACHMENT_BODY_INVALID');
}

function assertAttachmentContract(entry: AttachmentManifestEntry): void {
  const fileName = basename(entry.sourceRelativeKey);
  if (
    fileName !== entry.sourceRelativeKey.split('/').at(-1) ||
    fileName.length === 0 ||
    Buffer.byteLength(fileName) > 255 ||
    /[\u0000-\u001f\u007f]/u.test(fileName) ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    entry.objectKey !==
      `migration/daily-reports/${entry.reportKey}/${entry.sha256}-${fileName}`
  ) {
    throw new Error('TARGET_ATTACHMENT_CONTRACT_INVALID');
  }
}

function inspectFile(path: string): { bytes: Buffer; sha256: string; signature: string } {
  const declared = resolve(path);
  const stat = lstatSync(declared, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('TARGET_ATTACHMENT_SOURCE_INVALID');
  }
  const bytes = readFileSync(declared);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
  };
}

export class AwsMigrationTarget implements MigrationTarget {
  private safe = false;

  constructor(
    readonly config: TargetConfiguration,
    readonly clients: AwsMigrationClients,
  ) {
    assertExplicitTargetConfiguration(config);
  }

  async assertSafeTarget(): Promise<void> {
    this.safe = false;
    const identity = (await this.clients.sts.send(
      new GetCallerIdentityCommand({}) as unknown as { input?: Record<string, unknown> },
    )) as { Account?: string };
    if (identity.Account !== EXPECTED_ACCOUNT_ID) throw new Error('TARGET_ACCOUNT_MISMATCH');

    const appResult = (await this.clients.amplify.send(
      new GetAppCommand({ appId: this.config.amplifyApp.appId }) as unknown as { input?: Record<string, unknown> },
    )) as { app?: { appId?: string; name?: string; appArn?: string; tags?: Record<string, string> } };
    const app = appResult.app;
    if (
      app?.appId !== this.config.amplifyApp.appId ||
      app.name !== EXPECTED_APP_NAME ||
      app.appArn !== `arn:aws:amplify:${EXPECTED_REGION}:${EXPECTED_ACCOUNT_ID}:apps/${this.config.amplifyApp.appId}`
    ) {
      throw new Error('TARGET_APP_MISMATCH');
    }
    assertRequiredTags(app.tags, 'AmplifyApp');

    const stackResources = new Map<string, Array<{ PhysicalResourceId?: string; ResourceType?: string }>>();
    for (const stack of Object.values(this.config.stacks)) {
      const described = (await this.clients.cloudFormation.send(
        new DescribeStacksCommand({ StackName: stack.name }) as unknown as { input?: Record<string, unknown> },
      )) as { Stacks?: Array<{ StackName?: string; StackId?: string; Tags?: unknown }> };
      if (
        described.Stacks?.length !== 1 ||
        described.Stacks[0].StackName !== stack.name ||
        described.Stacks[0].StackId !== stack.arn
      ) {
        throw new Error(`TARGET_STACK_MISMATCH:${stack.name}`);
      }
      assertRequiredTags(described.Stacks[0].Tags, `Stack:${stack.name}`);
      const resources: Array<{ PhysicalResourceId?: string; ResourceType?: string }> = [];
      let nextToken: string | undefined;
      do {
        const listed = (await this.clients.cloudFormation.send(
          new ListStackResourcesCommand({ StackName: stack.name, NextToken: nextToken }) as unknown as { input?: Record<string, unknown> },
        )) as { StackResourceSummaries?: Array<{ PhysicalResourceId?: string; ResourceType?: string }>; NextToken?: string };
        resources.push(...(listed.StackResourceSummaries ?? []));
        nextToken = listed.NextToken;
      } while (nextToken);
      stackResources.set(stack.name, resources);
    }

    for (const [model, table] of Object.entries(this.config.tables) as Array<[MigrationModelName, NamedResource]>) {
      const described = (await this.clients.dynamo.send(
        new DescribeTableCommand({ TableName: table.name }) as unknown as { input?: Record<string, unknown> },
      )) as { Table?: { TableName?: string; TableArn?: string } };
      if (described.Table?.TableName !== table.name || described.Table.TableArn !== table.arn) {
        throw new Error(`TARGET_TABLE_MISMATCH:${model}`);
      }
      const tagged = (await this.clients.dynamo.send(
        new ListDynamoTagsCommand({ ResourceArn: table.arn }) as unknown as { input?: Record<string, unknown> },
      )) as { Tags?: unknown };
      assertRequiredTags(tagged.Tags, `Table:${model}`);
      if (!stackResources.get(table.stackName)?.some(
        (entry) => entry.PhysicalResourceId === table.name && entry.ResourceType === 'AWS::DynamoDB::Table',
      )) {
        throw new Error(`TARGET_STACK_RESOURCE_MISMATCH:${model}`);
      }
    }

    const location = (await this.clients.s3.send(
      new GetBucketLocationCommand({ Bucket: this.config.bucket.name }) as unknown as { input?: Record<string, unknown> },
    )) as { LocationConstraint?: string };
    if (location.LocationConstraint !== EXPECTED_REGION) throw new Error('TARGET_BUCKET_REGION_MISMATCH');
    const bucketTags = (await this.clients.s3.send(
      new GetBucketTaggingCommand({ Bucket: this.config.bucket.name }) as unknown as { input?: Record<string, unknown> },
    )) as { TagSet?: unknown };
    assertRequiredTags(bucketTags.TagSet, 'Bucket');
    if (!stackResources.get(this.config.bucket.stackName)?.some(
      (entry) => entry.PhysicalResourceId === this.config.bucket.name && entry.ResourceType === 'AWS::S3::Bucket',
    )) {
      throw new Error('TARGET_STACK_RESOURCE_MISMATCH:Bucket');
    }

    const pool = (await this.clients.cognito.send(
      new DescribeUserPoolCommand({ UserPoolId: this.config.userPool.id }) as unknown as { input?: Record<string, unknown> },
    )) as { UserPool?: { Id?: string; Arn?: string } };
    if (
      pool.UserPool?.Id !== this.config.userPool.id ||
      pool.UserPool.Arn !== this.config.userPool.arn
    ) {
      throw new Error('TARGET_USER_POOL_MISMATCH');
    }
    const poolTags = (await this.clients.cognito.send(
      new ListTagsForResourceCommand({ ResourceArn: this.config.userPool.arn }) as unknown as { input?: Record<string, unknown> },
    )) as { Tags?: unknown };
    assertRequiredTags(poolTags.Tags, 'UserPool');
    const groupNames: string[] = [];
    const seenGroupTokens = new Set<string>();
    let groupToken: string | undefined;
    do {
      const page = (await this.clients.cognito.send(
        new ListGroupsCommand({
          UserPoolId: this.config.userPool.id,
          NextToken: groupToken,
        }) as unknown as { input?: Record<string, unknown> },
      )) as { Groups?: Array<{ GroupName?: string }>; NextToken?: string };
      for (const group of page.Groups ?? []) {
        if (typeof group.GroupName !== 'string') {
          throw new Error('TARGET_COGNITO_GROUPS_INVALID');
        }
        groupNames.push(group.GroupName);
      }
      groupToken = page.NextToken;
      if (groupToken) {
        if (seenGroupTokens.has(groupToken)) {
          throw new Error('TARGET_COGNITO_GROUPS_PAGINATION_CYCLE');
        }
        seenGroupTokens.add(groupToken);
      }
    } while (groupToken);
    if (
      new Set(groupNames).size !== groupNames.length ||
      [...groupNames].sort().join(',') !== 'KITCHEN,OWNER'
    ) {
      throw new Error('TARGET_COGNITO_GROUPS_MISMATCH');
    }
    if (!stackResources.get(this.config.userPool.stackName)?.some(
      (entry) => entry.PhysicalResourceId === this.config.userPool.id && entry.ResourceType === 'AWS::Cognito::UserPool',
    )) {
      throw new Error('TARGET_STACK_RESOURCE_MISMATCH:UserPool');
    }
    this.safe = true;
  }

  private requireSafe(): void {
    if (!this.safe) throw new Error('TARGET_PREFLIGHT_REQUIRED');
  }

  async putRecord(
    model: MigrationModelName,
    key: string,
    record: Record<string, unknown>,
  ): Promise<'created' | 'unchanged'> {
    this.requireSafe();
    const primaryKey = model === 'DailyReport' ? 'reportKey' : 'id';
    if (record[primaryKey] !== key) throw new Error(`TARGET_RECORD_KEY_MISMATCH:${model}`);
    const normalized = canonicalize(record) as Record<string, unknown>;
    const table = this.config.tables[model];
    try {
      await this.clients.dynamo.send(
        new PutItemCommand({
          TableName: table.name,
          Item: marshalRecord(normalized),
          ConditionExpression: 'attribute_not_exists(#primaryKey)',
          ExpressionAttributeNames: { '#primaryKey': primaryKey },
        }) as unknown as { input?: Record<string, unknown> },
      );
      return 'created';
    } catch (error) {
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
    }
    const existing = (await this.clients.dynamo.send(
      new GetItemCommand({
        TableName: table.name,
        Key: marshalRecord({ [primaryKey]: key }),
        ConsistentRead: true,
      }) as unknown as { input?: Record<string, unknown> },
    )) as { Item?: Record<string, AttributeValue> };
    if (!existing.Item) throw new Error(`TARGET_RECORD_CONDITIONAL_RACE:${model}:${key}`);
    if (canonicalJson(unmarshalRecord(existing.Item)) !== canonicalJson(normalized)) {
      throw new Error(`TARGET_RECORD_CONFLICT:${model}:${key}`);
    }
    return 'unchanged';
  }

  async putAttachment(
    entry: AttachmentManifestEntry,
    sourcePath: string,
  ): Promise<'created' | 'unchanged'> {
    this.requireSafe();
    assertAttachmentContract(entry);
    const before = inspectFile(sourcePath);
    if (before.bytes.length !== entry.byteSize || before.sha256 !== entry.sha256) {
      throw new Error(`TARGET_ATTACHMENT_SOURCE_MISMATCH:${entry.objectKey}`);
    }
    const existing = await this.headAttachment(entry.objectKey, true);
    if (existing) {
      this.assertHeadMatches(entry, existing);
      const after = inspectFile(sourcePath);
      if (
        after.signature !== before.signature ||
        after.bytes.length !== before.bytes.length ||
        after.sha256 !== before.sha256
      ) {
        throw new Error(`TARGET_ATTACHMENT_SOURCE_CHANGED:${entry.objectKey}`);
      }
      return 'unchanged';
    }
    let created = true;
    try {
      await this.clients.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket.name,
          Key: entry.objectKey,
          Body: before.bytes,
          IfNoneMatch: '*',
          Metadata: { sha256: entry.sha256, 'byte-size': String(entry.byteSize) },
        }) as unknown as { input?: Record<string, unknown> },
      );
    } catch (error) {
      if (!['PreconditionFailed', 'ConditionalRequestConflict'].includes(errorName(error))) {
        throw error;
      }
      created = false;
    }
    const after = inspectFile(sourcePath);
    if (
      after.signature !== before.signature ||
      after.bytes.length !== before.bytes.length ||
      after.sha256 !== before.sha256
    ) {
      throw new Error(`TARGET_ATTACHMENT_SOURCE_CHANGED:${entry.objectKey}`);
    }
    const head = await this.headAttachment(entry.objectKey, false);
    if (!head) throw new Error(`TARGET_ATTACHMENT_UPLOAD_UNVERIFIED:${entry.objectKey}`);
    this.assertHeadMatches(entry, head);
    return created ? 'created' : 'unchanged';
  }

  private async headAttachment(
    objectKey: string,
    allowMissing: boolean,
  ): Promise<{ ContentLength?: number; Metadata?: Record<string, string> } | null> {
    try {
      return (await this.clients.s3.send(
        new HeadObjectCommand({ Bucket: this.config.bucket.name, Key: objectKey }) as unknown as { input?: Record<string, unknown> },
      )) as { ContentLength?: number; Metadata?: Record<string, string> };
    } catch (error) {
      if (allowMissing && isMissingObject(error)) return null;
      throw error;
    }
  }

  private assertHeadMatches(
    entry: Pick<AttachmentManifestEntry, 'objectKey' | 'byteSize' | 'sha256'>,
    head: { ContentLength?: number; Metadata?: Record<string, string> },
  ): void {
    if (
      head.ContentLength !== entry.byteSize ||
      head.Metadata?.sha256 !== entry.sha256 ||
      head.Metadata['byte-size'] !== String(entry.byteSize)
    ) {
      throw new Error(`TARGET_ATTACHMENT_CONFLICT:${entry.objectKey}`);
    }
  }

  async listRecords(model: MigrationModelName): Promise<Record<string, unknown>[]> {
    this.requireSafe();
    const records: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const page = (await this.clients.dynamo.send(
        new ScanCommand({
          TableName: this.config.tables[model].name,
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }) as unknown as { input?: Record<string, unknown> },
      )) as { Items?: Array<Record<string, AttributeValue>>; LastEvaluatedKey?: Record<string, AttributeValue> };
      records.push(...(page.Items ?? []).map(unmarshalRecord));
      exclusiveStartKey = page.LastEvaluatedKey;
      if (exclusiveStartKey) {
        const token = canonicalJson(exclusiveStartKey);
        if (seen.has(token)) throw new Error(`TARGET_SCAN_PAGINATION_CYCLE:${model}`);
        seen.add(token);
      }
    } while (exclusiveStartKey);
    return records;
  }

  async readAttachment(objectKey: string): Promise<{ byteSize: number; sha256: string }> {
    this.requireSafe();
    const head = await this.headAttachment(objectKey, false);
    if (!head) throw new Error(`TARGET_ATTACHMENT_NOT_FOUND:${objectKey}`);
    const object = (await this.clients.s3.send(
      new GetObjectCommand({ Bucket: this.config.bucket.name, Key: objectKey }) as unknown as { input?: Record<string, unknown> },
    )) as { Body?: unknown };
    const bytes = await bodyBytes(object.Body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      head.ContentLength !== bytes.length ||
      head.Metadata?.sha256 !== digest ||
      head.Metadata['byte-size'] !== String(bytes.length)
    ) {
      throw new Error(`TARGET_ATTACHMENT_CHECKSUM_MISMATCH:${objectKey}`);
    }
    return { byteSize: bytes.length, sha256: digest };
  }
}

export function createAwsMigrationTarget(config: TargetConfiguration): AwsMigrationTarget {
  assertExplicitTargetConfiguration(config);
  const region = config.region;
  return new AwsMigrationTarget(config, {
    sts: new STSClient({ region }) as unknown as CommandClient,
    amplify: new AmplifyClient({ region }) as unknown as CommandClient,
    cloudFormation: new CloudFormationClient({ region }) as unknown as CommandClient,
    dynamo: new DynamoDBClient({ region }) as unknown as CommandClient,
    s3: new S3Client({ region }) as unknown as CommandClient,
    cognito: new CognitoIdentityProviderClient({ region }) as unknown as CommandClient,
  });
}

export function targetConfigurationFingerprint(config: TargetConfiguration): string {
  assertExplicitTargetConfiguration(config);
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}
