/**
 * The condition language behind custom folders and split inboxes.
 *
 * A flat list of conditions plus one match mode — "match ALL of the
 * following" or "match ANY of the following". That is the Apple Mail / Gmail
 * filter model, and it is deliberately not a nested boolean tree: nesting
 * multiplies the UI surface and the ways to build something subtly wrong,
 * while covering a small tail of queries nobody has asked for. `not` is
 * expressed per condition (`is not`) rather than as a wrapper, which is how
 * people describe the same idea out loud.
 *
 * Shared here in the db package because two evaluators consume it — the SQL
 * builder in the web app's queries, and the client-side one in the list pane
 * — and a folder whose badge count disagrees with its contents is the bug
 * this shape exists to prevent.
 */

/** What a condition can look at. */
export const QUERY_FIELDS = [
  'kind',
  'tag',
  'inbox',
  'assignee',
  'priority',
  'status',
  'words',
  'unread',
  'seen',
  'has',
  'pinned',
  'muted',
  'sla',
] as const;

export type QueryField = (typeof QUERY_FIELDS)[number];

/**
 * `is` / `is_not` cover the enum and id fields; `contains` / `not_contains`
 * are for free text. Booleans use `is` with 'true' / 'false' so every
 * condition has the same shape.
 */
export type QueryOperator = 'is' | 'is_not' | 'contains' | 'not_contains';

export interface QueryCondition {
  field: QueryField;
  operator: QueryOperator;
  /** Enum member, id, or free text depending on the field. */
  value: string;
}

export interface FolderQuery {
  /** 'all' = AND across conditions, 'any' = OR. */
  match: 'all' | 'any';
  conditions: QueryCondition[];
}

/** Fields whose value is free text rather than a fixed set or an id. */
export const TEXT_FIELDS: QueryField[] = ['words'];

/** Fields that are yes/no; their value is 'true' or 'false'. */
export const BOOLEAN_FIELDS: QueryField[] = ['unread', 'seen', 'pinned', 'muted', 'sla'];

/** The fixed choices for each enum field, in display order. */
export const FIELD_CHOICES: Partial<Record<QueryField, readonly string[]>> = {
  kind: ['person', 'unknown', 'automated', 'otp'],
  priority: ['urgent', 'high', 'normal', 'low'],
  status: ['open', 'pending', 'snoozed', 'closed'],
  has: ['photo', 'attachment', 'voice', 'link'],
};

/** Human labels, so the builder and the folder description agree on wording. */
export const FIELD_LABELS: Record<QueryField, string> = {
  kind: 'Sender type',
  tag: 'Tag',
  inbox: 'Number',
  assignee: 'Assignee',
  priority: 'Priority',
  status: 'Status',
  words: 'Message text',
  unread: 'Unread',
  seen: 'Read, no reply',
  has: 'Contains',
  pinned: 'Pinned',
  muted: 'Muted',
  sla: 'Overdue',
};

/** Which operators make sense for a field. */
export function operatorsFor(field: QueryField): QueryOperator[] {
  if (TEXT_FIELDS.includes(field)) return ['contains', 'not_contains'];
  if (BOOLEAN_FIELDS.includes(field)) return ['is'];
  return ['is', 'is_not'];
}

/**
 * Drop conditions that can't be evaluated — an empty value would otherwise
 * read as "no restriction" and silently widen the folder to everything.
 */
export function sanitizeQuery(query: FolderQuery | null | undefined): FolderQuery | null {
  if (!query) return null;
  const conditions = (query.conditions ?? []).filter(
    (c) =>
      c &&
      (QUERY_FIELDS as readonly string[]).includes(c.field) &&
      typeof c.value === 'string' &&
      c.value.trim().length > 0,
  );
  if (conditions.length === 0) return null;
  return {
    match: query.match === 'any' ? 'any' : 'all',
    conditions: conditions.map((c) => ({ ...c, value: c.value.trim() })),
  };
}

/** One-line description of a query, for folder subtitles. */
export function describeQuery(query: FolderQuery): string {
  const joiner = query.match === 'any' ? ' or ' : ' and ';
  return query.conditions
    .map((c) => {
      const label = FIELD_LABELS[c.field];
      if (BOOLEAN_FIELDS.includes(c.field)) return c.value === 'false' ? `not ${label}` : label;
      const op =
        c.operator === 'is_not'
          ? 'is not'
          : c.operator === 'contains'
            ? 'contains'
            : c.operator === 'not_contains'
              ? "doesn't contain"
              : 'is';
      return `${label} ${op} ${c.value}`;
    })
    .join(joiner);
}
