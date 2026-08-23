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

const CREATE_SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  status text NOT NULL CHECK (status = 'SUCCEEDED'),
  applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const databaseUrlError = (code: string): Error =>
  new Error(`DATABASE_URL_${code}`);

const FORBIDDEN_DATABASE_URL_PARAMETERS = new Set([
  'database',
  'dbname',
  'host',
  'hostaddr',
  'passfile',
  'password',
  'port',
  'service',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'user',
]);

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
    [...parsed.searchParams.keys()].some((key) =>
      FORBIDDEN_DATABASE_URL_PARAMETERS.has(key.toLowerCase()),
    )
  ) {
    throw databaseUrlError('QUERY_OVERRIDE_FORBIDDEN');
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
  const appliedByVersion = new Map(
    applied.map((migration) => [migration.version, migration.checksum]),
  );
  const seenVersions = new Set<string>();

  return [...files]
    .sort((left, right) => left.version.localeCompare(right.version))
    .filter((migration) => {
      if (seenVersions.has(migration.version)) {
        throw new Error('MIGRATION_DUPLICATE_VERSION');
      }
      seenVersions.add(migration.version);

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
      const match = /^(\d{3,})_[a-z0-9][a-z0-9_-]*\.sql$/.exec(fileName);
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

  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error('MIGRATION_DUPLICATE_VERSION');
    }
    versions.add(migration.version);
  }

  return migrations;
}

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

  await client.query('BEGIN');
  try {
    await client.query(CREATE_SCHEMA_MIGRATIONS_SQL);
    await client.query(
      'LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE',
    );
    const appliedResult = await client.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
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
        `INSERT INTO schema_migrations (version, checksum, status)
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
