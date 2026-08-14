/**
 * The client-side twin of `conditionSql` in `@/server/queries`.
 *
 * Both evaluate the same stored `FolderQuery`; one against Postgres, one
 * against the rows already loaded in the list pane. They have to agree — a
 * folder whose sidebar badge says 7 and whose section shows 4 is a bug people
 * lose trust over, and it is the only failure mode this file exists to
 * prevent. The two are covered by one shared test table for that reason.
 *
 * Anything that cannot be answered from a loaded row (full-archive search,
 * say) must not become a query field. Fail closed instead: an unknown field
 * matches nothing on both sides rather than quietly meaning "no restriction".
 */

import { sanitizeQuery, type FolderQuery, type QueryCondition } from '@comms/db/query';

/**
 * What a row must expose to be testable. Deliberately structural — the list
 * pane's `ConversationListItem`, a search hit, and a test fixture all satisfy
 * it without anyone importing a server type into the browser.
 */
export interface QueryRow {
  kind?: string | null;
  status?: string | null;
  priority?: string | null;
  inboxId?: string | null;
  assigneeId?: string | null;
  unreadCount?: number | null;
  mutedAt?: Date | string | null;
  slaBreachedAt?: Date | string | null;
  lastMessagePreview?: string | null;
  title?: string | null;
  /**
   * The media/seen flags arrive as SQL `extras`, which Drizzle types as
   * `unknown`. Taking them as `unknown` here and coercing with `Boolean` is
   * honest about that, and saves every caller a cast.
   */
  readNoReply?: unknown;
  hasPhoto?: unknown;
  hasAttachment?: unknown;
  hasVoice?: unknown;
  hasLink?: unknown;
  /** Whether the *viewer* pinned it — resolved by the caller, like the SQL. */
  pinned?: boolean | null;
  tagIds?: string[];
}

/** Everything the evaluator needs that isn't on the row itself. */
export interface QueryContext {
  currentUserId?: string;
}

/**
 * Evaluate one condition, ignoring negation — `matchesCondition` applies that
 * uniformly so `is_not` can never drift from `is` on a single field.
 */
function conditionHolds(c: QueryCondition, row: QueryRow, ctx: QueryContext): boolean {
  const text = (v: string | null | undefined) => (v ?? '').toLowerCase();

  switch (c.field) {
    case 'kind':
      return row.kind === c.value;
    case 'status':
      return row.status === c.value;
    case 'priority':
      return row.priority === c.value;
    case 'inbox':
      return row.inboxId === c.value;
    case 'assignee':
      if (c.value === 'unassigned') return !row.assigneeId;
      return row.assigneeId === (c.value === 'me' ? (ctx.currentUserId ?? '') : c.value);
    case 'tag':
      return (row.tagIds ?? []).includes(c.value);
    case 'words': {
      const hay = `${text(row.lastMessagePreview)} ${text(row.title)}`;
      return hay.includes(c.value.toLowerCase());
    }
    case 'has':
      return Boolean(
        c.value === 'photo'
          ? row.hasPhoto
          : c.value === 'voice'
            ? row.hasVoice
            : c.value === 'link'
              ? row.hasLink
              : row.hasAttachment,
      );
    case 'unread':
      return (row.unreadCount ?? 0) > 0;
    case 'seen':
      return Boolean(row.readNoReply);
    case 'muted':
      return row.mutedAt != null;
    case 'sla':
      return row.slaBreachedAt != null;
    case 'pinned':
      return Boolean(row.pinned);
    default:
      // Unknown field: matches nothing, exactly like the SQL's `false` branch.
      return false;
  }
}

/**
 * Boolean fields read their polarity from the value ('true' / 'false')
 * because that is how the builder renders them; every other field expresses
 * negation through the operator. Keeping both in one place is what stops the
 * two evaluators from disagreeing about what "is not" means.
 */
const BOOLEAN_VALUED = new Set(['unread', 'seen', 'muted', 'sla', 'pinned']);

export function matchesCondition(c: QueryCondition, row: QueryRow, ctx: QueryContext = {}): boolean {
  const holds = conditionHolds(c, row, ctx);
  // An unrecognised field can never be satisfied, not even by negating it.
  if (!isKnownField(c.field)) return false;
  if (BOOLEAN_VALUED.has(c.field)) return c.value === 'false' ? !holds : holds;
  return c.operator === 'is_not' || c.operator === 'not_contains' ? !holds : holds;
}

function isKnownField(field: string): boolean {
  return (
    field === 'kind' ||
    field === 'status' ||
    field === 'priority' ||
    field === 'inbox' ||
    field === 'assignee' ||
    field === 'tag' ||
    field === 'words' ||
    field === 'has' ||
    BOOLEAN_VALUED.has(field)
  );
}

/**
 * Does a row satisfy a whole folder query?
 *
 * A query with nothing evaluable in it returns `true` — it is *no query*, not
 * an impossible one. `sanitizeQuery` is what makes that safe: it strips
 * blank-valued conditions before they can be mistaken for "no restriction",
 * so a half-filled builder row never silently widens a folder to everything.
 */
export function matchesQuery(
  query: FolderQuery | null | undefined,
  row: QueryRow,
  ctx: QueryContext = {},
): boolean {
  const q = sanitizeQuery(query);
  if (!q) return true;
  return q.match === 'any'
    ? q.conditions.some((c) => matchesCondition(c, row, ctx))
    : q.conditions.every((c) => matchesCondition(c, row, ctx));
}
