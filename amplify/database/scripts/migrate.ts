import { join } from 'node:path';

import { Client } from 'pg';

import {
  applyMigrations,
  assertStagingDatabaseUrl,
  loadMigrationFiles,
  type MigrationClient,
  type MigrationPlanEntry,
} from './migration-lib.js';

export async function runMigrations(
  client: MigrationClient,
  migrationsDirectory: string,
): Promise<MigrationPlanEntry[]> {
  const migrations = await loadMigrationFiles(migrationsDirectory);
  return applyMigrations(client, migrations);
}

const safeErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]*$/.test(message) ? message : 'MIGRATION_FAILED';
};

async function main(): Promise<void> {
  const databaseUrl = assertStagingDatabaseUrl(process.env.DATABASE_URL);
  const migrationsDirectory = join(__dirname, '../migrations');
  const pgClient = new Client({ connectionString: databaseUrl });
  const client: MigrationClient = {
    query: async (text, values) => pgClient.query(text, values),
  };

  await pgClient.connect();
  try {
    const applied = await runMigrations(client, migrationsDirectory);
    console.log(`MIGRATIONS_APPLIED count=${applied.length}`);
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
