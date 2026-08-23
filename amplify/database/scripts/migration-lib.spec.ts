import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyMigrations,
  assertStagingDatabaseUrl,
  loadMigrationFiles,
  planMigrations,
  type MigrationClient,
} from './migration-lib.js';
import { verifySchema } from './verify-schema.js';
import {
  seedStaging,
  type SeedSettings,
  type SeedShift,
  type SeedUser,
  type StagingSeedRepository,
} from './seed-staging.js';
import { runMigrations } from './migrate.js';

class FakeMigrationClient implements MigrationClient {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];

  constructor(
    private readonly applied: Array<{ version: string; checksum: string }> = [],
    private readonly failingSql?: string,
  ) {}

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });

    if (text === this.failingSql) {
      throw new Error('synthetic migration failure');
    }
    if (text.includes('SELECT version, checksum') && text.includes('schema_migrations')) {
      return { rows: this.applied };
    }

    return { rows: [] };
  }
}

describe('migration planning', () => {
  it('plans an unapplied migration in version order', () => {
    expect(
      planMigrations([], [
        { version: '002', checksum: 'def' },
        { version: '001', checksum: 'abc' },
      ]),
    ).toEqual([
      { version: '001', checksum: 'abc' },
      { version: '002', checksum: 'def' },
    ]);
  });

  it('skips a migration with the same checksum', () => {
    expect(
      planMigrations(
        [{ version: '001', checksum: 'abc' }],
        [{ version: '001', checksum: 'abc' }],
      ),
    ).toEqual([]);
  });

  it('rejects checksum drift for an applied version', () => {
    expect(() =>
      planMigrations(
        [{ version: '001', checksum: 'old' }],
        [{ version: '001', checksum: 'new' }],
      ),
    ).toThrow('MIGRATION_CHECKSUM_MISMATCH');
  });

  it('rejects an applied migration whose committed file was deleted', () => {
    expect(() =>
      planMigrations(
        [
          { version: '001', checksum: 'abc' },
          { version: '002', checksum: 'def' },
        ],
        [{ version: '001', checksum: 'abc' }],
      ),
    ).toThrow('MIGRATION_APPLIED_VERSION_MISSING');
  });

  it('rejects renumbering an already-applied migration', () => {
    expect(() =>
      planMigrations(
        [{ version: '001', checksum: 'abc' }],
        [{ version: '002', checksum: 'abc' }],
      ),
    ).toThrow('MIGRATION_APPLIED_VERSION_MISSING');
  });

  it.each(['01', '1000', 'abc'])(
    'rejects non-three-digit migration version %s',
    (version) => {
      expect(() => planMigrations([], [{ version, checksum: 'abc' }])).toThrow(
        'MIGRATION_VERSION_INVALID',
      );
    },
  );

  it('rejects a gap in committed migration versions', () => {
    expect(() =>
      planMigrations([], [
        { version: '001', checksum: 'abc' },
        { version: '003', checksum: 'ghi' },
      ]),
    ).toThrow('MIGRATION_VERSION_GAP');
  });

  it('rejects applied history that is not a contiguous committed prefix', () => {
    expect(() =>
      planMigrations(
        [
          { version: '001', checksum: 'abc' },
          { version: '003', checksum: 'ghi' },
        ],
        [
          { version: '001', checksum: 'abc' },
          { version: '002', checksum: 'def' },
          { version: '003', checksum: 'ghi' },
        ],
      ),
    ).toThrow('MIGRATION_APPLIED_HISTORY_NOT_PREFIX');
  });
});

describe('migration file loading', () => {
  it('loads versioned SQL in order with content-derived checksums', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));

    try {
      await writeFile(join(directory, '002_second.sql'), 'SELECT 2;');
      await writeFile(join(directory, '001_first.sql'), 'SELECT 1;');

      await expect(loadMigrationFiles(directory)).resolves.toEqual([
        {
          fileName: '001_first.sql',
          version: '001',
          sql: 'SELECT 1;',
          checksum: createHash('sha256').update('SELECT 1;').digest('hex'),
        },
        {
          fileName: '002_second.sql',
          version: '002',
          sql: 'SELECT 2;',
          checksum: createHash('sha256').update('SELECT 2;').digest('hex'),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an empty migration directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));

    try {
      await expect(loadMigrationFiles(directory)).rejects.toThrow(
        'MIGRATION_DIRECTORY_EMPTY',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects SQL files without a versioned stable filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));

    try {
      await writeFile(join(directory, 'bootstrap.sql'), 'SELECT 1;');

      await expect(loadMigrationFiles(directory)).rejects.toThrow(
        'MIGRATION_FILENAME_INVALID',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a four-digit migration filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));

    try {
      await writeFile(join(directory, '1000_future.sql'), 'SELECT 1;');

      await expect(loadMigrationFiles(directory)).rejects.toThrow(
        'MIGRATION_FILENAME_INVALID',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a gap in migration filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));

    try {
      await writeFile(join(directory, '001_first.sql'), 'SELECT 1;');
      await writeFile(join(directory, '003_third.sql'), 'SELECT 3;');

      await expect(loadMigrationFiles(directory)).rejects.toThrow(
        'MIGRATION_VERSION_GAP',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const BUSINESS_TABLES = [
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

const tableBlock = (sql: string, tableName: string): string => {
  const startPattern = new RegExp(
    `CREATE TABLE(?: IF NOT EXISTS)?\\s+public\\.${tableName}\\s*\\(`,
    'i',
  );
  const start = sql.search(startPattern);
  if (start === -1) return '';

  const remainder = sql.slice(start + 1);
  const nextOffset = remainder.search(
    /\nCREATE TABLE(?: IF NOT EXISTS)?\s+public\./i,
  );
  return nextOffset === -1 ? sql.slice(start) : sql.slice(start, start + 1 + nextOffset);
};

describe('authoritative bootstrap DDL', () => {
  it('creates schema metadata plus exactly ten business tables with text primary keys', async () => {
    const sql = await readFile(
      'amplify/database/migrations/001_bootstrap.sql',
      'utf8',
    );
    const tables = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+public\.([a-z_]+)\s*\(/gi)]
      .map((match) => match[1])
      .sort();

    expect(tables).toEqual([...BUSINESS_TABLES, 'schema_migrations'].sort());
    expect(BUSINESS_TABLES).toHaveLength(10);
    for (const table of BUSINESS_TABLES) {
      expect(tableBlock(sql, table), `${table} must have an explicit text PK`).toMatch(
        /\bid\s+text\s+PRIMARY KEY\b/i,
      );
    }
    expect(tableBlock(sql, 'schema_migrations')).toMatch(
      /\bversion\s+text\s+PRIMARY KEY\b/i,
    );
  });

  it('enforces roles and both daily-report unique invariants', async () => {
    const sql = await readFile(
      'amplify/database/migrations/001_bootstrap.sql',
      'utf8',
    );
    const appUser = tableBlock(sql, 'app_user');
    const report = tableBlock(sql, 'daily_report');

    expect(appUser).toMatch(
      /CHECK\s*\(\s*role\s+IN\s*\(\s*'ADMIN'\s*,\s*'KITCHEN'\s*\)\s*\)/i,
    );
    expect(appUser).not.toContain('WEBMASTER');
    expect(report).toMatch(/UNIQUE\s*\(\s*idempotency_key\s*\)/i);
    expect(report).toMatch(
      /UNIQUE\s*\(\s*report_date\s*,\s*shift_id\s*\)/i,
    );
  });

  it('stores raw yen as checked integers and all four persisted totals as bigint', async () => {
    const sql = await readFile(
      'amplify/database/migrations/001_bootstrap.sql',
      'utf8',
    );
    const settings = tableBlock(sql, 'app_settings');
    const report = tableBlock(sql, 'daily_report');
    const rawSettingsAmounts = ['register_float_amount'];
    const rawReportAmounts = [
      'register_float_amount_snapshot',
      'previous_imos_balance_yen',
      'current_imos_balance_yen',
      'newage_yen',
      'cash_total_yen',
      'expense_yen',
      'staff_meal_cash_yen',
      'staff_meal_alipay_yen',
    ];
    const derivedReportAmounts = [
      'imos_sales_yen',
      'cash_deposit_yen',
      'total_sales_yen',
      'deviation_yen',
    ];

    for (const column of rawSettingsAmounts) {
      expect(settings).toMatch(
        new RegExp(
          `\\b${column}\\s+integer\\b[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+BETWEEN\\s+0\\s+AND\\s+2000000000\\s*\\)`,
          'i',
        ),
      );
    }
    for (const column of rawReportAmounts) {
      expect(report).toMatch(
        new RegExp(
          `\\b${column}\\s+integer\\b[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+BETWEEN\\s+0\\s+AND\\s+2000000000\\s*\\)`,
          'i',
        ),
      );
    }
    for (const column of derivedReportAmounts) {
      expect(report).toMatch(new RegExp(`\\b${column}\\s+bigint\\b`, 'i'));
    }
    expect(report).not.toMatch(/\bstaff_meal_total_yen\b/i);
  });

  it('covers the combined min/max capacity of every persisted derived amount', () => {
    const maximumRawYen = 2_000_000_000;

    expect({
      imosSalesYen: [0 - maximumRawYen, maximumRawYen - 0],
      cashDepositYen: [0 - maximumRawYen, maximumRawYen - 0],
      totalSalesYen: [
        0 + 0 - maximumRawYen - maximumRawYen,
        maximumRawYen + maximumRawYen - 0 - 0,
      ],
      deviationYen: [
        -4_000_000_000 + 0 - maximumRawYen,
        4_000_000_000 + maximumRawYen - -maximumRawYen,
      ],
    }).toEqual({
      imosSalesYen: [-2_000_000_000, 2_000_000_000],
      cashDepositYen: [-2_000_000_000, 2_000_000_000],
      totalSalesYen: [-4_000_000_000, 4_000_000_000],
      deviationYen: [-6_000_000_000, 8_000_000_000],
    });
    expect(8_000_000_000).toBeGreaterThan(2_147_483_647);
    expect(Number.isSafeInteger(8_000_000_000)).toBe(true);
  });

  it('provides the foreign keys, snapshots, and audit fields used by trusted writes', async () => {
    const sql = await readFile(
      'amplify/database/migrations/001_bootstrap.sql',
      'utf8',
    );
    const report = tableBlock(sql, 'daily_report');
    const revision = tableBlock(sql, 'daily_report_revision');

    for (const requiredFragment of [
      'shift_id text NOT NULL REFERENCES public.shift(id)',
      'responsible_person_id text NOT NULL REFERENCES public.responsible_person(id)',
      'created_by_user_id text NOT NULL REFERENCES public.app_user(id)',
      'shift_name_snapshot text NOT NULL',
      'responsible_person_snapshot text NOT NULL',
      'created_by_cognito_subject_snapshot text NOT NULL',
      'created_by_username_snapshot text NOT NULL',
      'created_at timestamp with time zone NOT NULL',
      'updated_at timestamp with time zone NOT NULL',
    ]) {
      expect(report).toContain(requiredFragment);
    }
    expect(revision).toMatch(/before_snapshot\s+jsonb\s+NOT NULL/i);
    expect(revision).toMatch(/after_snapshot\s+jsonb\s+NOT NULL/i);
    expect(revision).toContain(
      'corrected_by_cognito_subject_snapshot text NOT NULL',
    );
    expect(revision).toContain('corrected_by_username_snapshot text NOT NULL');
  });
});

describe('transactional migration application', () => {
  it('computes SHA-256, applies sorted DDL, and records success before commit', async () => {
    const client = new FakeMigrationClient();
    const sql001 = 'CREATE TABLE first_table (id text PRIMARY KEY)';
    const sql002 = 'CREATE TABLE second_table (id text PRIMARY KEY)';

    await applyMigrations(client, [
      { version: '002', sql: sql002 },
      { version: '001', sql: sql001 },
    ]);

    const texts = client.calls.map(({ text }) => text);
    const inserts = client.calls.filter(({ text }) =>
      text.includes('INSERT INTO public.schema_migrations'),
    );

    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe(
      'SELECT pg_catalog.pg_advisory_xact_lock(1179863883, 5)',
    );
    expect(texts[2]).toMatch(
      /^CREATE TABLE IF NOT EXISTS public\.schema_migrations/,
    );
    expect(texts[3]).toBe(
      'LOCK TABLE public.schema_migrations IN ACCESS EXCLUSIVE MODE',
    );
    expect(texts.indexOf(sql001)).toBeLessThan(texts.indexOf(sql002));
    expect(inserts.map(({ values }) => values)).toEqual([
      [
        '001',
        createHash('sha256').update(sql001).digest('hex'),
        'SUCCEEDED',
      ],
      [
        '002',
        createHash('sha256').update(sql002).digest('hex'),
        'SUCCEEDED',
      ],
    ]);
    expect(texts.at(-1)).toBe('COMMIT');
  });

  it('rolls back failed DDL without recording migration success', async () => {
    const failingSql = 'CREATE TABLE broken (';
    const client = new FakeMigrationClient([], failingSql);

    await expect(
      applyMigrations(client, [{ version: '001', sql: failingSql }]),
    ).rejects.toThrow('synthetic migration failure');

    expect(client.calls.map(({ text }) => text).at(-1)).toBe('ROLLBACK');
    expect(
      client.calls.some(({ text }) => text.includes('INSERT INTO schema_migrations')),
    ).toBe(false);
  });

  it.each([
    'BEGIN; SELECT 1;',
    'START TRANSACTION; SELECT 1;',
    'SELECT 1; COMMIT;',
    'END;',
    '-- misleading comment\nROLLBACK;',
    'ABORT;',
    "PREPARE TRANSACTION 'migration-001';",
    "COMMIT PREPARED 'migration-001';",
    "ROLLBACK PREPARED 'migration-001';",
    'SAVEPOINT migration_001;',
    'RELEASE SAVEPOINT migration_001;',
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
  ])('rejects migration-owned transaction control before BEGIN: %s', async (sql) => {
    const client = new FakeMigrationClient();

    await expect(
      applyMigrations(client, [{ version: '001', sql }]),
    ).rejects.toThrow('MIGRATION_TRANSACTION_CONTROL_FORBIDDEN');
    expect(client.calls).toEqual([]);
  });
});

describe('migration runner wiring', () => {
  it('loads the version-controlled directory and applies its SQL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fsk-migrations-'));
    const client = new FakeMigrationClient();

    try {
      await writeFile(join(directory, '001_bootstrap.sql'), 'SELECT 1;');

      await expect(runMigrations(client, directory)).resolves.toEqual([
        {
          version: '001',
          checksum: createHash('sha256').update('SELECT 1;').digest('hex'),
        },
      ]);
      expect(client.calls.some(({ text }) => text === 'SELECT 1;')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('staging PostgreSQL DATABASE_URL guard', () => {
  it.each(['require', 'verify-full'])(
    'accepts the explicit remote fsk_staging database with sslmode=%s',
    (sslmode) => {
      const databaseUrl =
        `postgresql://stage_user:secret@fsk-staging.cluster-example.ap-northeast-1.rds.amazonaws.com:5432/fsk_staging?sslmode=${sslmode}`;

      expect(assertStagingDatabaseUrl(databaseUrl)).toBe(databaseUrl);
    },
  );

  it('rejects a remote URL without an approved TLS parameter', () => {
    expect(
      () =>
        assertStagingDatabaseUrl(
          'postgresql://stage_user:secret@fsk-staging.cluster-example.ap-northeast-1.rds.amazonaws.com:5432/fsk_staging',
        ),
    ).toThrow('DATABASE_URL_TLS_PARAMETER_REQUIRED');
  });

  it.each([
    'postgresql://user:secret@localhost:5432/fsk_staging',
    'postgresql://user:secret@db-localhost.example:5432/fsk_staging',
    'postgresql://user:secret@127.0.0.1:5432/fsk_staging',
    'postgresql://user:secret@[::1]:5432/fsk_staging',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?host=localhost',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?host=%2Ftmp',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?password=override',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?sslkey=%2Ftmp%2Fclient.key',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?options=-csearch_path%3Devil%2Cpublic',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?application_name=fsk',
    'postgresql://user:secret@fsk.example:5432/fsk_staging?sslmode=disable',
    'postgresql://user:secret@fsk.example:5432/postgres',
    'postgresql://user:secret@fsk.example:5432/dev.db',
    'file:./apps/api/prisma/dev.db',
    'not a url',
  ])('rejects unsafe DATABASE_URL %j without echoing it', (databaseUrl) => {
    expect(() => assertStagingDatabaseUrl(databaseUrl)).toThrow(
      /^DATABASE_URL_[A-Z_]+$/,
    );

    try {
      assertStagingDatabaseUrl(databaseUrl);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain(databaseUrl);
    }
  });
});

const expectedPrimaryKeys = [
  ...BUSINESS_TABLES.map((tableName) => ({
    table_name: tableName,
    column_name: 'id',
    data_type: 'text',
  })),
  {
    table_name: 'schema_migrations',
    column_name: 'version',
    data_type: 'text',
  },
];

const expectedAmountColumns = [
  {
    table_name: 'app_settings',
    column_name: 'register_float_amount',
    data_type: 'integer',
    check_expressions: [
      '((register_float_amount >= 0) AND (register_float_amount <= 2000000000))',
    ],
  },
  ...[
    'register_float_amount_snapshot',
    'previous_imos_balance_yen',
    'current_imos_balance_yen',
    'newage_yen',
    'cash_total_yen',
    'expense_yen',
    'staff_meal_cash_yen',
    'staff_meal_alipay_yen',
  ].map((columnName) => ({
    table_name: 'daily_report',
    column_name: columnName,
    data_type: 'integer',
    check_expressions: [
      `((${columnName} >= 0) AND (${columnName} <= 2000000000))`,
    ],
  })),
  ...[
    'imos_sales_yen',
    'cash_deposit_yen',
    'total_sales_yen',
    'deviation_yen',
  ].map((columnName) => ({
    table_name: 'daily_report',
    column_name: columnName,
    data_type: 'bigint',
    check_expressions: [],
  })),
];

type VerificationFixture = {
  tables: Array<Record<string, unknown>>;
  primaryKeys: Array<Record<string, unknown>>;
  uniqueConstraints: Array<Record<string, unknown>>;
  uniqueIndexes: Array<Record<string, unknown>>;
  amountColumns: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
};

const validVerificationFixture = (): VerificationFixture => ({
  tables: [...BUSINESS_TABLES, 'schema_migrations'].map((tableName) => ({
    table_name: tableName,
  })),
  primaryKeys: expectedPrimaryKeys,
  uniqueConstraints: [
    { columns: ['idempotency_key'] },
    { columns: ['report_date', 'shift_id'] },
  ],
  uniqueIndexes: [
    {
      columns: ['idempotency_key'],
      is_global: true,
      has_only_columns: true,
    },
    {
      columns: ['report_date', 'shift_id'],
      is_global: true,
      has_only_columns: true,
    },
  ],
  amountColumns: expectedAmountColumns,
  migrations: [
    { version: '001', checksum: 'expected-checksum', status: 'SUCCEEDED' },
  ],
});

class FakeVerificationClient implements MigrationClient {
  readonly calls: string[] = [];

  constructor(private readonly fixture: VerificationFixture) {}

  async query(text: string) {
    this.calls.push(text);

    if (text.includes("constraint_type = 'PRIMARY KEY'")) {
      return { rows: this.fixture.primaryKeys };
    }
    if (text.includes("constraint_type = 'UNIQUE'")) {
      return { rows: this.fixture.uniqueConstraints };
    }
    if (text.includes('FROM pg_catalog.pg_index')) {
      return { rows: this.fixture.uniqueIndexes };
    }
    if (text.includes('FROM information_schema.tables')) {
      return { rows: this.fixture.tables };
    }
    if (text.includes('FROM information_schema.columns c')) {
      return { rows: this.fixture.amountColumns };
    }
    if (text.includes('schema_migrations')) {
      return { rows: this.fixture.migrations };
    }
    throw new Error('unexpected verification query');
  }
}

describe('read-only schema verification', () => {
  it('verifies ten business tables plus metadata without issuing writes', async () => {
    const client = new FakeVerificationClient(validVerificationFixture());

    await expect(
      verifySchema(client, [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).resolves.toEqual({ businessTableCount: 10, migrationCount: 1 });

    expect(client.calls).toHaveLength(5);
    for (const query of client.calls) {
      expect(query.trim()).toMatch(/^(SELECT|WITH)\b/i);
      expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|LOCK)\b/i);
    }
    expect(client.calls.some((query) => query.includes('FROM public.schema_migrations'))).toBe(
      true,
    );
    expect(
      client.calls.some((query) =>
        query.includes('FROM pg_catalog.pg_index'),
      ),
    ).toBe(true);
    expect(
      client.calls.find((query) =>
        query.includes('FROM pg_catalog.pg_index'),
      ),
    ).toMatch(/index_definition\.indpred\s+IS\s+NULL/i);
  });

  it('rejects a missing business table', async () => {
    const fixture = validVerificationFixture();
    fixture.tables = fixture.tables.filter(
      (row) => row.table_name !== 'migration_item',
    );

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_TABLE_SET_MISMATCH');
  });

  it('rejects a missing or non-text primary key', async () => {
    const fixture = validVerificationFixture();
    fixture.primaryKeys = fixture.primaryKeys.map((row) =>
      row.table_name === 'attachment' ? { ...row, data_type: 'uuid' } : row,
    );

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_PRIMARY_KEY_MISMATCH');
  });

  it('rejects a missing daily report uniqueness invariant', async () => {
    const fixture = validVerificationFixture();
    fixture.uniqueConstraints = [{ columns: ['idempotency_key'] }];
    fixture.uniqueIndexes = [
      {
        columns: ['idempotency_key'],
        is_global: true,
        has_only_columns: true,
      },
    ];

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  });

  it('rejects an extra dangerous daily report unique constraint', async () => {
    const fixture = validVerificationFixture();
    fixture.uniqueConstraints.push({ columns: ['report_date'] });
    fixture.uniqueIndexes.push({
      columns: ['report_date'],
      is_global: true,
      has_only_columns: true,
    });

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  });

  it('rejects an extra standalone unique index on report_date', async () => {
    const fixture = validVerificationFixture();
    fixture.uniqueIndexes.push({
      columns: ['report_date'],
      is_global: true,
      has_only_columns: true,
    });

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  });

  it('rejects a partial index substituting for a required global unique key', async () => {
    const fixture = validVerificationFixture();
    fixture.uniqueIndexes[0] = {
      columns: ['idempotency_key'],
      is_global: false,
      has_only_columns: true,
    };

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  });

  it('rejects an expression index substituting for a required unique key', async () => {
    const fixture = validVerificationFixture();
    fixture.uniqueIndexes[0] = {
      columns: ['lower(idempotency_key)'],
      is_global: true,
      has_only_columns: false,
    };

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_DAILY_REPORT_UNIQUE_MISMATCH');
  });

  it('rejects a raw amount without the full integer range check', async () => {
    const fixture = validVerificationFixture();
    fixture.amountColumns = fixture.amountColumns.map((row) =>
      row.column_name === 'staff_meal_cash_yen'
        ? {
            ...row,
            check_expressions: [
              '((staff_meal_cash_yen < 0) OR (staff_meal_cash_yen > 2000000000))',
            ],
          }
        : row,
    );

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
  });

  it('rejects OR-based raw bounds that do not enforce the range', async () => {
    const fixture = validVerificationFixture();
    fixture.amountColumns = fixture.amountColumns.map((row) =>
      row.column_name === 'staff_meal_cash_yen'
        ? {
            ...row,
            check_expressions: [
              '((staff_meal_cash_yen >= 0) OR (staff_meal_cash_yen <= 2000000000))',
            ],
          }
        : row,
    );

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
  });

  it('rejects any CHECK constraint on a persisted derived amount', async () => {
    const fixture = validVerificationFixture();
    fixture.amountColumns = fixture.amountColumns.map((row) =>
      row.column_name === 'imos_sales_yen'
        ? {
            ...row,
            check_expressions: ['(imos_sales_yen >= 0)'],
          }
        : row,
    );

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_AMOUNT_CONTRACT_MISMATCH');
  });

  it('rejects migration checksum drift', async () => {
    const fixture = validVerificationFixture();
    fixture.migrations = [
      { version: '001', checksum: 'changed', status: 'SUCCEEDED' },
    ];

    await expect(
      verifySchema(new FakeVerificationClient(fixture), [
        { version: '001', checksum: 'expected-checksum' },
      ]),
    ).rejects.toThrow('SCHEMA_MIGRATION_CHECKSUM_MISMATCH');
  });
});

class FakeSeedRepository implements StagingSeedRepository {
  readonly users = new Map<string, SeedUser>();
  readonly shifts = new Map<string, SeedShift>();
  readonly responsiblePeople = new Map<string, { id: string; name: string }>();
  readonly settings = new Map<string, SeedSettings>();
  transactionCount = 0;

  async withTransaction<T>(
    work: (repository: StagingSeedRepository) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    return work(this);
  }

  async findUserCognitoSubjectForUpdate(id: string): Promise<string | null> {
    return this.users.get(id)?.cognitoSubject ?? null;
  }

  async upsertUser(user: SeedUser): Promise<void> {
    this.users.set(user.id, user);
  }

  async upsertShift(shift: SeedShift): Promise<void> {
    this.shifts.set(shift.id, shift);
  }

  async upsertResponsiblePerson(person: {
    id: string;
    name: string;
  }): Promise<void> {
    this.responsiblePeople.set(person.id, person);
  }

  async upsertSettings(settings: SeedSettings): Promise<void> {
    this.settings.set(settings.id, settings);
  }
}

describe('deterministic staging seed', () => {
  it('upserts only the two synthetic stage users and fixed four shifts', async () => {
    const repository = new FakeSeedRepository();

    await seedStaging(repository);

    expect([...repository.users.values()]).toEqual([
      {
        id: 'stage-admin',
        cognitoSubject: 'stage-admin',
        usernameSnapshot: 'stage-admin',
        role: 'ADMIN',
        active: true,
      },
      {
        id: 'stage-kitchen',
        cognitoSubject: 'stage-kitchen',
        usernameSnapshot: 'stage-kitchen',
        role: 'KITCHEN',
        active: true,
      },
    ]);
    expect([...repository.shifts.values()]).toEqual([
      {
        id: 'fixed-shift-webmaster-morning',
        name: '网管早班',
        sortOrder: 1,
        active: true,
      },
      {
        id: 'fixed-shift-day',
        name: '白班',
        sortOrder: 2,
        active: true,
      },
      {
        id: 'fixed-shift-night',
        name: '夜班',
        sortOrder: 3,
        active: true,
      },
      {
        id: 'fixed-shift-webmaster-night',
        name: '网管夜班',
        sortOrder: 4,
        active: true,
      },
    ]);
  });

  it('is idempotent and creates only synthetic responsible-person/settings rows', async () => {
    const repository = new FakeSeedRepository();

    await seedStaging(repository);
    await seedStaging(repository);

    expect(repository.transactionCount).toBe(2);
    expect(repository.users.size).toBe(2);
    expect(repository.shifts.size).toBe(4);
    expect([...repository.responsiblePeople.values()]).toEqual([
      { id: 'stage-responsible-person', name: '合成测试负责人' },
    ]);
    expect([...repository.settings.values()]).toEqual([
      {
        id: 'default',
        registerFloatAmount: 50_000,
        setupCompleted: true,
        updatedByUserId: 'stage-admin',
      },
    ]);
  });

  it('preserves a reconciled Cognito subject on later seed runs', async () => {
    const repository = new FakeSeedRepository();

    await seedStaging(repository);
    repository.users.set('stage-admin', {
      ...repository.users.get('stage-admin')!,
      cognitoSubject: 'cognito-real-admin-subject',
    });

    await seedStaging(repository);

    expect(repository.users.get('stage-admin')?.cognitoSubject).toBe(
      'cognito-real-admin-subject',
    );
    expect(repository.users.get('stage-kitchen')?.cognitoSubject).toBe(
      'stage-kitchen',
    );
  });

  it('locks user subjects and schema-qualifies all PostgreSQL seed statements', async () => {
    const seedModule = (await import('./seed-staging.js')) as unknown as {
      createPgStagingSeedRepository?: (
        client: {
          query(
            text: string,
            values?: unknown[],
          ): Promise<{ rows: Array<Record<string, unknown>> }>;
        },
      ) => StagingSeedRepository;
    };
    expect(seedModule.createPgStagingSeedRepository).toBeTypeOf('function');

    const statements: string[] = [];
    const repository = seedModule.createPgStagingSeedRepository!({
      async query(text: string) {
        statements.push(text);
        return { rows: [] };
      },
    });

    await seedStaging(repository);

    const tableStatements = statements.filter((text) =>
      /\b(?:FROM|INTO)\s+(?:app_user|shift|responsible_person|app_settings)\b/i.test(
        text,
      ),
    );
    expect(tableStatements).toEqual([]);
    expect(
      statements.filter((text) => /\b(?:FROM|INTO)\s+public\./i.test(text)),
    ).toHaveLength(10);
    expect(statements.filter((text) => /SELECT cognito_subject/i.test(text))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/FROM public\.app_user[\s\S]*FOR UPDATE/i),
      ]),
    );
  });
});
