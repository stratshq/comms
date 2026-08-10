import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXPECTED_MIGRATION_COUNT } from '../src/migrations-meta';

const here = dirname(fileURLToPath(import.meta.url));

describe('EXPECTED_MIGRATION_COUNT', () => {
  it('matches the number of migrations in the journal', () => {
    const journal = JSON.parse(
      readFileSync(join(here, '..', 'migrations', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };

    // If this fails you added a migration: bump EXPECTED_MIGRATION_COUNT.
    // Leaving it stale would make the admin panel's Health tab claim the
    // database is behind (or ahead of) a schema it is actually on.
    expect(EXPECTED_MIGRATION_COUNT).toBe(journal.entries.length);
  });
});
