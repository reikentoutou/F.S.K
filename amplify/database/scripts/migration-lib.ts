import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

export interface MigrationPlanEntry {
  version: string;
  checksum: string;
}

export interface MigrationSource {
  version: string;
  sql: string;
}

export interface LoadedMigration extends MigrationSource, MigrationPlanEntry {
  fileName: string;
}

export interface MigrationClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const CREATE_SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  status text NOT NULL CHECK (status = 'SUCCEEDED'),
  applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const MIGRATION_ADVISORY_LOCK_SQL =
  'SELECT pg_catalog.pg_advisory_xact_lock(1179863883, 5)';

const databaseUrlError = (code: string): Error =>
  new Error(`DATABASE_URL_${code}`);

const ALLOWED_SSL_MODES = new Set(['require', 'verify-full']);

const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host.includes('localhost') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('::ffff:127.')
  ) {
    return true;
  }

  return isIP(host) === 4 && host.startsWith('127.');
};

export function assertStagingDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw databaseUrlError('REQUIRED');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw databaseUrlError('MALFORMED');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw databaseUrlError('MUST_BE_POSTGRESQL');
  }
  if (!parsed.hostname || !parsed.username || !parsed.password) {
    throw databaseUrlError('MUST_BE_EXPLICIT');
  }
  if (
    [...parsed.searchParams.keys()].some(
      (key) => key.toLowerCase() !== 'sslmode',
    )
  ) {
    throw databaseUrlError('QUERY_PARAMETER_FORBIDDEN');
  }
  const sslModes = parsed.searchParams.getAll('sslmode');
  if (sslModes.length === 0) {
    throw databaseUrlError('TLS_PARAMETER_REQUIRED');
  }
  if (sslModes.length !== 1 || !ALLOWED_SSL_MODES.has(sslModes[0])) {
    throw databaseUrlError('TLS_PARAMETER_INVALID');
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw databaseUrlError('LOCALHOST_FORBIDDEN');
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw databaseUrlError('MALFORMED');
  }
  if (databasePath.toLowerCase().includes('dev.db')) {
    throw databaseUrlError('DEV_DATABASE_FORBIDDEN');
  }
  if (databasePath !== '/fsk_staging') {
    throw databaseUrlError('DATABASE_MUST_BE_FSK_STAGING');
  }

  return databaseUrl;
}

export function planMigrations(
  applied: MigrationPlanEntry[],
  files: MigrationPlanEntry[],
): MigrationPlanEntry[] {
  const committedVersions = validateVersionShapeAndDuplicates(files);
  const appliedVersions = new Set<string>();
  for (const migration of applied) {
    if (!/^\d{3}$/.test(migration.version)) {
      throw new Error('MIGRATION_VERSION_INVALID');
    }
    if (appliedVersions.has(migration.version)) {
      throw new Error('MIGRATION_DUPLICATE_VERSION');
    }
    appliedVersions.add(migration.version);
    if (!committedVersions.has(migration.version)) {
      throw new Error('MIGRATION_APPLIED_VERSION_MISSING');
    }
  }
  const sortedFiles = validateCommittedVersions(files);
  const sortedApplied = [...applied].sort((left, right) =>
    left.version.localeCompare(right.version),
  );
  for (const [index, migration] of sortedApplied.entries()) {
    if (migration.version !== sortedFiles[index]?.version) {
      throw new Error('MIGRATION_APPLIED_HISTORY_NOT_PREFIX');
    }
  }

  const appliedByVersion = new Map(
    applied.map((migration) => [migration.version, migration.checksum]),
  );

  return sortedFiles
    .filter((migration) => {
      const appliedChecksum = appliedByVersion.get(migration.version);
      if (appliedChecksum === undefined) {
        return true;
      }
      if (appliedChecksum !== migration.checksum) {
        throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      }
      return false;
    })
    .map(({ version, checksum }) => ({ version, checksum }));
}

const validateVersionShapeAndDuplicates = <T extends MigrationPlanEntry>(
  files: T[],
): Set<string> => {
  const versions = new Set<string>();
  for (const migration of files) {
    if (!/^\d{3}$/.test(migration.version)) {
      throw new Error('MIGRATION_VERSION_INVALID');
    }
    if (versions.has(migration.version)) {
      throw new Error('MIGRATION_DUPLICATE_VERSION');
    }
    versions.add(migration.version);
  }
  return versions;
};

const validateCommittedVersions = <T extends MigrationPlanEntry>(
  files: T[],
): T[] => {
  const sorted = [...files].sort((left, right) =>
    left.version.localeCompare(right.version),
  );
  validateVersionShapeAndDuplicates(sorted);

  for (const [index, migration] of sorted.entries()) {
    const expectedVersion = String(index + 1).padStart(3, '0');
    if (migration.version !== expectedVersion) {
      throw new Error('MIGRATION_VERSION_GAP');
    }
  }

  return sorted;
};

const checksumSql = (sql: string): string =>
  createHash('sha256').update(sql).digest('hex');

export async function loadMigrationFiles(
  directory: string,
): Promise<LoadedMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (sqlFiles.length === 0) {
    throw new Error('MIGRATION_DIRECTORY_EMPTY');
  }

  const migrations = await Promise.all(
    sqlFiles.map(async (fileName) => {
      const match = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/.exec(fileName);
      if (!match) {
        throw new Error('MIGRATION_FILENAME_INVALID');
      }
      const sql = await readFile(join(directory, fileName), 'utf8');
      return {
        fileName,
        version: match[1],
        sql,
        checksum: checksumSql(sql),
      };
    }),
  );

  return validateCommittedVersions(migrations);
}

const stripSqlCommentsAndLiterals = (sql: string): string => {
  let result = '';
  let index = 0;

  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      if (newline === -1) {
        return result;
      }
      result += '\n';
      index = newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) {
        return result;
      }
      result += ' ';
      index = end + 2;
      continue;
    }

    const character = sql[index];
    if (character === "'" || character === '"') {
      const delimiter = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === delimiter) {
          if (sql[index + 1] === delimiter) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      result += ' ';
      continue;
    }

    if (character === '$') {
      const dollarTag = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(
        sql.slice(index),
      )?.[0];
      if (dollarTag) {
        const end = sql.indexOf(dollarTag, index + dollarTag.length);
        if (end === -1) {
          return result;
        }
        result += ' ';
        index = end + dollarTag.length;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
};

const TRANSACTION_CONTROL_PATTERN =
  /(?:^|;)\s*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|PREPARE\s+TRANSACTION\b|SAVEPOINT\b|RELEASE(?:\s+SAVEPOINT)?\b|SET\s+TRANSACTION\b)/i;

const assertNoMigrationTransactionControl = (sql: string): void => {
  const executableSql = stripSqlCommentsAndLiterals(sql);
  if (TRANSACTION_CONTROL_PATTERN.test(executableSql)) {
    throw new Error('MIGRATION_TRANSACTION_CONTROL_FORBIDDEN');
  }
};

export async function applyMigrations(
  client: MigrationClient,
  files: MigrationSource[],
): Promise<MigrationPlanEntry[]> {
  const sources = [...files]
    .map((migration) => ({
      ...migration,
      checksum: checksumSql(migration.sql),
    }))
    .sort((left, right) => left.version.localeCompare(right.version));

  validateCommittedVersions(sources);
  for (const source of sources) {
    assertNoMigrationTransactionControl(source.sql);
  }

  await client.query('BEGIN');
  try {
    await client.query(MIGRATION_ADVISORY_LOCK_SQL);
    await client.query(CREATE_SCHEMA_MIGRATIONS_SQL);
    await client.query(
      'LOCK TABLE public.schema_migrations IN ACCESS EXCLUSIVE MODE',
    );
    const appliedResult = await client.query(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
    );
    const applied = appliedResult.rows.map((row) => ({
      version: String(row.version),
      checksum: String(row.checksum),
    }));
    const pending = planMigrations(applied, sources);

    for (const migration of pending) {
      const source = sources.find(
        (candidate) => candidate.version === migration.version,
      );
      if (!source) {
        throw new Error('MIGRATION_SOURCE_MISSING');
      }
      await client.query(source.sql);
      await client.query(
        `INSERT INTO public.schema_migrations (version, checksum, status)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.checksum, 'SUCCEEDED'],
      );
    }

    await client.query('COMMIT');
    return pending;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
