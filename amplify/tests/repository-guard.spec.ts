import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
const migrationsDirectory = 'amplify/database/migrations';

function migrationFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? migrationFiles(path) : [path];
  });
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
    expect(migrationFiles(migrationsDirectory)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:\.db$|\.zip$|(?:^|[\\/])uploads(?:[\\/]|$))/),
      ]),
    );
  });
});
