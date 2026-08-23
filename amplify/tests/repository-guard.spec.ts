import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
const migrationsDirectory = 'amplify/database/migrations';

function migrationFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...migrationFiles(path)] : [path];
  });
}

function hasProhibitedMigrationArtifact(paths: string[]): boolean {
  return paths.some((path) => /(?:\.db$|\.zip$|(?:^|[\\/])uploads(?:[\\/]|$))/.test(path));
}

describe('Amplify repository guard', () => {
  it.each([
    'amplify_outputs.json',
    '.amplify/',
    'amplify/.env*',
    'amplify/database/tmp/',
    'amplify/tests/fixtures/private/',
  ])('ignores %s', (entry) => expect(ignore).toContain(entry));

  it('keeps migration artifacts free of databases, archives, and uploads', () => {
    expect(hasProhibitedMigrationArtifact(migrationFiles(migrationsDirectory))).toBe(false);
  });

  it('rejects an empty uploads directory in migrations', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'amplify-migrations-'));
    const prohibitedDirectory = join(fixtureDirectory, 'uploads');
    mkdirSync(prohibitedDirectory);

    try {
      expect(hasProhibitedMigrationArtifact(migrationFiles(fixtureDirectory))).toBe(true);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
