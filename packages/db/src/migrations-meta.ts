/**
 * How many migrations this build ships.
 *
 * The admin panel compares it against the rows in `drizzle.__drizzle_migrations`
 * to answer "is this database actually on this build's schema" — the quiet
 * failure behind a deploy whose pre-deploy migration step didn't run.
 *
 * Hardcoded rather than read from the journal at runtime because the journal
 * is a build artifact of this package and the web app bundles its code, not
 * its files. `migrations-meta.test.ts` asserts this number still matches
 * `migrations/meta/_journal.json`, so adding a migration without bumping it
 * fails CI rather than silently reporting a phantom pending migration.
 */
export const EXPECTED_MIGRATION_COUNT = 15;
