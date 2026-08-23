import { Client } from 'pg';

import { assertStagingDatabaseUrl } from './migration-lib.js';

export interface SeedUser {
  id: string;
  cognitoSubject: string;
  usernameSnapshot: string;
  role: 'ADMIN' | 'KITCHEN';
  active: true;
}

export interface SeedShift {
  id: string;
  name: '网管早班' | '白班' | '夜班' | '网管夜班';
  sortOrder: 1 | 2 | 3 | 4;
  active: true;
}

export interface SeedSettings {
  id: 'default';
  registerFloatAmount: number;
  setupCompleted: true;
  updatedByUserId: 'stage-admin';
}

export interface StagingSeedRepository {
  withTransaction<T>(
    work: (repository: StagingSeedRepository) => Promise<T>,
  ): Promise<T>;
  upsertUser(user: SeedUser): Promise<void>;
  upsertShift(shift: SeedShift): Promise<void>;
  upsertResponsiblePerson(person: {
    id: string;
    name: string;
  }): Promise<void>;
  upsertSettings(settings: SeedSettings): Promise<void>;
}

export const STAGING_USERS: readonly SeedUser[] = [
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
] as const;

// These IDs are staging-only fixtures. Production migration preserves source IDs.
export const STAGING_FIXED_SHIFTS: readonly SeedShift[] = [
  {
    id: 'fixed-shift-webmaster-morning',
    name: '网管早班',
    sortOrder: 1,
    active: true,
  },
  { id: 'fixed-shift-day', name: '白班', sortOrder: 2, active: true },
  { id: 'fixed-shift-night', name: '夜班', sortOrder: 3, active: true },
  {
    id: 'fixed-shift-webmaster-night',
    name: '网管夜班',
    sortOrder: 4,
    active: true,
  },
] as const;

const STAGING_RESPONSIBLE_PERSON = {
  id: 'stage-responsible-person',
  name: '合成测试负责人',
} as const;

const STAGING_SETTINGS: SeedSettings = {
  id: 'default',
  registerFloatAmount: 50_000,
  setupCompleted: true,
  updatedByUserId: 'stage-admin',
};

export async function seedStaging(
  repository: StagingSeedRepository,
): Promise<{ users: 2; shifts: 4; responsiblePeople: 1; settings: 1 }> {
  return repository.withTransaction(async (transaction) => {
    for (const user of STAGING_USERS) {
      await transaction.upsertUser(user);
    }
    for (const shift of STAGING_FIXED_SHIFTS) {
      await transaction.upsertShift(shift);
    }
    await transaction.upsertResponsiblePerson(STAGING_RESPONSIBLE_PERSON);
    await transaction.upsertSettings(STAGING_SETTINGS);

    return { users: 2, shifts: 4, responsiblePeople: 1, settings: 1 };
  });
}

interface QueryExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

class PgStagingSeedRepository implements StagingSeedRepository {
  constructor(private readonly client: QueryExecutor) {}

  async withTransaction<T>(
    work: (repository: StagingSeedRepository) => Promise<T>,
  ): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await work(this);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  async upsertUser(user: SeedUser): Promise<void> {
    await this.client.query(
      `INSERT INTO app_user (
         id, cognito_subject, username_snapshot, role, active
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         cognito_subject = EXCLUDED.cognito_subject,
         username_snapshot = EXCLUDED.username_snapshot,
         role = EXCLUDED.role,
         active = EXCLUDED.active,
         updated_at = CURRENT_TIMESTAMP
       WHERE (app_user.cognito_subject, app_user.username_snapshot, app_user.role, app_user.active)
         IS DISTINCT FROM
         (EXCLUDED.cognito_subject, EXCLUDED.username_snapshot, EXCLUDED.role, EXCLUDED.active)`,
      [
        user.id,
        user.cognitoSubject,
        user.usernameSnapshot,
        user.role,
        user.active,
      ],
    );
  }

  async upsertShift(shift: SeedShift): Promise<void> {
    await this.client.query(
      `INSERT INTO shift (id, name, sort_order, active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         sort_order = EXCLUDED.sort_order,
         active = EXCLUDED.active,
         updated_at = CURRENT_TIMESTAMP
       WHERE (shift.name, shift.sort_order, shift.active)
         IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.sort_order, EXCLUDED.active)`,
      [shift.id, shift.name, shift.sortOrder, shift.active],
    );
  }

  async upsertResponsiblePerson(person: {
    id: string;
    name: string;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO responsible_person (id, name, active)
       VALUES ($1, $2, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         active = EXCLUDED.active,
         updated_at = CURRENT_TIMESTAMP
       WHERE (responsible_person.name, responsible_person.active)
         IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.active)`,
      [person.id, person.name],
    );
  }

  async upsertSettings(settings: SeedSettings): Promise<void> {
    await this.client.query(
      `INSERT INTO app_settings (
         id, register_float_amount, setup_completed, updated_by_user_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         register_float_amount = EXCLUDED.register_float_amount,
         setup_completed = EXCLUDED.setup_completed,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = CURRENT_TIMESTAMP
       WHERE (
         app_settings.register_float_amount,
         app_settings.setup_completed,
         app_settings.updated_by_user_id
       ) IS DISTINCT FROM (
         EXCLUDED.register_float_amount,
         EXCLUDED.setup_completed,
         EXCLUDED.updated_by_user_id
       )`,
      [
        settings.id,
        settings.registerFloatAmount,
        settings.setupCompleted,
        settings.updatedByUserId,
      ],
    );
  }
}

const safeErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]*$/.test(message) ? message : 'STAGING_SEED_FAILED';
};

async function main(): Promise<void> {
  const databaseUrl = assertStagingDatabaseUrl(process.env.DATABASE_URL);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    const result = await seedStaging(new PgStagingSeedRepository(client));
    console.log(
      `STAGING_SEED_APPLIED users=${result.users} shifts=${result.shifts} responsible_people=${result.responsiblePeople} settings=${result.settings}`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(safeErrorCode(error));
    process.exitCode = 1;
  });
}
