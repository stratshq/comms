export { getDb, closeDb, schema, type Database } from './client.js';
export { ensureAppSecret } from './secret.js';
export {
  getRuntimeOverrides,
  setRuntimeOverrides,
  clampRuntimeOverrides,
  resetRuntimeOverridesCache,
  type RuntimeOverrides,
} from './runtime.js';
export * as tables from './schema/index.js';
export * from './schema/index.js';

// Re-export drizzle-orm query helpers so consumers don't need a direct dep.
export {
  eq,
  ne,
  and,
  or,
  not,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  desc,
  asc,
  sql,
  count,
  countDistinct,
} from 'drizzle-orm';
