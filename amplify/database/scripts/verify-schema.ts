import { join } from 'node:path';

import { Client } from 'pg';

import {
  assertStagingDatabaseUrl,
  loadMigrationFiles,
  type MigrationClient,
  type MigrationPlanEntry,
} from './migration-lib.js';

export const BUSINESS_TABLES = [
  'app_settings',
  'app_user',
  'attachment',
  'daily_report',
  'daily_report_revision',
  'export_job',
  'migration_item',
  'migration_run',
  'responsible_person',
  'shift',
] as const;

const ALL_TABLES = [...BUSINESS_TABLES, 'schema_migrations'].sort();

const RAW_AMOUNT_COLUMNS = [
  ['app_settings', 'register_float_amount'],
  ['daily_report', 'register_float_amount_snapshot'],
  ['daily_report', 'previous_imos_balance_yen'],
  ['daily_report', 'current_imos_balance_yen'],
  ['daily_report', 'newage_yen'],
  ['daily_report', 'cash_total_yen'],
  ['daily_report', 'expense_yen'],
  ['daily_report', 'staff_meal_cash_yen'],
  ['daily_report', 'staff_meal_alipay_yen'],
] as const;

const DERIVED_AMOUNT_COLUMNS = [
  ['daily_report', 'imos_sales_yen'],
  ['daily_report', 'cash_deposit_yen'],
  ['daily_report', 'total_sales_yen'],
  ['daily_report', 'deviation_yen'],
] as const;

const TABLES_SQL = `SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name`;

const PRIMARY_KEYS_SQL = `SELECT tc.table_name, kcu.column_name, c.data_type
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_schema = tc.constraint_schema
 AND kcu.constraint_name = tc.constraint_name
JOIN information_schema.columns c
  ON c.table_schema = kcu.table_schema
 AND c.table_name = kcu.table_name
 AND c.column_name = kcu.column_name
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY tc.table_name, kcu.ordinal_position`;

const DAILY_REPORT_UNIQUES_SQL = `SELECT array_agg(
         CASE
           WHEN index_key.attnum = 0 THEN pg_catalog.pg_get_indexdef(
             index_relation.oid,
             index_key.ordinality::integer,
             true
           )
           ELSE table_attribute.attname::text
         END
         ORDER BY index_key.ordinality
       ) AS columns,
       pg_catalog.bool_and(index_definition.indpred IS NULL) AS is_global,
       pg_catalog.bool_and(index_key.attnum <> 0) AS has_only_columns
FROM pg_catalog.pg_index index_definition
JOIN pg_catalog.pg_class table_relation
  ON table_relation.oid = index_definition.indrelid
JOIN pg_catalog.pg_namespace table_namespace
  ON table_namespace.oid = table_relation.relnamespace
JOIN pg_catalog.pg_class index_relation
  ON index_relation.oid = index_definition.indexrelid
JOIN LATERAL pg_catalog.unnest(index_definition.indkey) WITH ORDINALITY
  AS index_key(attnum, ordinality)
  ON index_key.ordinality <= index_definition.indnkeyatts
LEFT JOIN pg_catalog.pg_attribute table_attribute
  ON table_attribute.attrelid = table_relation.oid
 AND table_attribute.attnum = index_key.attnum
WHERE table_namespace.nspname = 'public'
  AND table_relation.relname = 'daily_report'
  AND index_definition.indisunique
  AND NOT index_definition.indisprimary
  AND index_definition.indisvalid
  AND index_definition.indisready
  AND index_definition.indislive
GROUP BY index_relation.oid, index_relation.relname
ORDER BY index_relation.relname`;

const AMOUNT_COLUMNS_SQL = `WITH expected_amount(table_name, column_name) AS (
  VALUES
    ('app_settings', 'register_float_amount'),
    ('daily_report', 'register_float_amount_snapshot'),
    ('daily_report', 'previous_imos_balance_yen'),
    ('daily_report', 'current_imos_balance_yen'),
    ('daily_report', 'newage_yen'),
    ('daily_report', 'cash_total_yen'),
    ('daily_report', 'expense_yen'),
    ('daily_report', 'staff_meal_cash_yen'),
    ('daily_report', 'staff_meal_alipay_yen'),
    ('daily_report', 'imos_sales_yen'),
    ('daily_report', 'cash_deposit_yen'),
    ('daily_report', 'total_sales_yen'),
    ('daily_report', 'deviation_yen')
)
SELECT c.table_name,
       c.column_name,
       c.data_type,
       ARRAY(
         SELECT pg_catalog.pg_get_expr(pc.conbin, pc.conrelid)
         FROM pg_catalog.pg_constraint pc
         JOIN pg_catalog.pg_class rel ON rel.oid = pc.conrelid
         JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
         JOIN pg_catalog.pg_attribute attr
           ON attr.attrelid = rel.oid
          AND attr.attname = c.column_name
          AND attr.attnum = ANY(pc.conkey)
         WHERE ns.nspname = 'public'
           AND rel.relname = c.table_name
           AND pc.contype = 'c'
       ) AS check_expressions
FROM information_schema.columns c
JOIN expected_amount e
  ON e.table_name = c.table_name
 AND e.column_name = c.column_name
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.column_name`;

const MIGRATIONS_SQL = `SELECT version, checksum, status
FROM public.schema_migrations
ORDER BY version`;

const sortedStrings = (values: string[]): string[] => [...values].sort();

const sameStringSet = (actual: string[], expected: string[]): boolean =>
  JSON.stringify(sortedStrings(actual)) === JSON.stringify(sortedStrings(expected));

const normalizedColumns = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

const hasRawAmountRangeCheck = (
  expressions: unknown,
  columnName: string,
): boolean => {
  const normalized = normalizedColumns(expressions).map((expression) =>
    expression.toLowerCase().replace(/[\s()"]/g, ''),
  );
  const acceptedExpressions = new Set([
    `${columnName}>=0and${columnName}<=2000000000`,
    `${columnName}<=2000000000and${columnName}>=0`,
    `${columnName}between0and2000000000`,
  ]);

  return normalized.length === 1 && acceptedExpressions.has(normalized[0]);
};

export async function verifySchema(
  client: MigrationClient,
  expectedMigrations: MigrationPlanEntry[],
): Promise<{ businessTableCount: number; migrationCount: number }> {
  const tablesResult = await client.query(TABLES_SQL);
  const primaryKeysResult = await client.query(PRIMARY_KEYS_SQL);
  const uniqueResult = await client.query(DAILY_REPORT_UNIQUES_SQL);
  const amountResult = await client.query(AMOUNT_COLUMNS_SQL);
  const migrationResult = await client.query(MIGRATIONS_SQL);

  const actualTables = tablesResult.rows.map((row) => String(row.table_name));
  if (!sameStringSet(actualTables, ALL_TABLES)) {
    throw new Error('SCHEMA_TABLE_SET_MISMATCH');
  }

  const expectedPrimaryKeys = [
    ...BUSINESS_TABLES.map((tableName) => `${tableName}:id:text`),
    'schema_migrations:version:text',
  ];
  const actualPrimaryKeys = primaryKeysResult.rows.map(
    (row) => `${String(row.table_name)}:${String(row.column_name)}:${String(row.data_type)}`,
  );
  if (!sameStringSet(actualPrimaryKeys, expectedPrimaryKeys)) {
    throw new Error('SCHEMA_PRIMARY_KEY_MISMATCH');
  }

  const uniqueColumns = uniqueResult.rows.map((row) =>
    normalizedColumns(row.columns).join(','),
  );
  if (
    uniqueResult.rows.some(
      (row) => row.is_global !== true || row.has_only_columns !== true,
    ) ||
    !sameStringSet(uniqueColumns, [
      'idempotency_key',
      'report_date,shift_id',
    ])
  ) {
    throw new Error('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  }

  const amountRows = new Map(
    amountResult.rows.map((row) => [
      `${String(row.table_name)}:${String(row.column_name)}`,
      row,
    ]),
  );
  const expectedAmountCount =
    RAW_AMOUNT_COLUMNS.length + DERIVED_AMOUNT_COLUMNS.length;
  if (amountRows.size !== expectedAmountCount) {
    throw new Error('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
  }
  for (const [tableName, columnName] of RAW_AMOUNT_COLUMNS) {
    const row = amountRows.get(`${tableName}:${columnName}`);
    if (
      row?.data_type !== 'integer' ||
      !hasRawAmountRangeCheck(row.check_expressions, columnName)
    ) {
      throw new Error('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
    }
  }
  for (const [tableName, columnName] of DERIVED_AMOUNT_COLUMNS) {
    const row = amountRows.get(`${tableName}:${columnName}`);
    if (
      row?.data_type !== 'bigint' ||
      normalizedColumns(row.check_expressions).length !== 0
    ) {
      throw new Error('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
    }
  }

  const expectedByVersion = new Map(
    expectedMigrations.map(({ version, checksum }) => [version, checksum]),
  );
  if (migrationResult.rows.length !== expectedByVersion.size) {
    throw new Error('SCHEMA_MIGRATION_CHECKSUM_MISMATCH');
  }
  for (const row of migrationResult.rows) {
    if (
      row.status !== 'SUCCEEDED' ||
      expectedByVersion.get(String(row.version)) !== String(row.checksum)
    ) {
      throw new Error('SCHEMA_MIGRATION_CHECKSUM_MISMATCH');
    }
  }

  return {
    businessTableCount: BUSINESS_TABLES.length,
    migrationCount: migrationResult.rows.length,
  };
}

const safeErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]*$/.test(message)
    ? message
    : 'SCHEMA_VERIFICATION_FAILED';
};

async function main(): Promise<void> {
  const databaseUrl = assertStagingDatabaseUrl(process.env.DATABASE_URL);
  const migrationsDirectory = join(__dirname, '../migrations');
  const migrations = await loadMigrationFiles(migrationsDirectory);
  const pgClient = new Client({ connectionString: databaseUrl });
  const client: MigrationClient = {
    query: async (text, values) => pgClient.query(text, values),
  };

  await pgClient.connect();
  try {
    const result = await verifySchema(client, migrations);
    console.log(
      `SCHEMA_VERIFIED business_tables=${result.businessTableCount} metadata_tables=1 migrations=${result.migrationCount}`,
    );
  } finally {
    await pgClient.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(safeErrorCode(error));
    process.exitCode = 1;
  });
}
