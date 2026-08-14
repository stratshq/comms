import { pgTable, text, integer, boolean, jsonb, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';
import { users } from './auth.js';
import type { FolderQuery } from './query.js';

/**
 * Where a folder appears. A sidebar row is navigation you go to; a section is
 * a header inside the inbox list you scroll past. The second one is what
 * people mean by "split inbox" — same object, different placement.
 */
export const viewDisplay = pgEnum('view_display', ['sidebar', 'section']);

/** The filter set behind a saved view — mirrors the inbox filter bar. */
export interface ViewFilters {
  status?: 'open' | 'pending' | 'snoozed' | 'closed' | 'drafts' | 'active' | 'all';
  /** A user id, or 'me' / 'unassigned'. */
  assignee?: string;
  inboxId?: string;
  tagIds?: string[];
  priorityIn?: Array<'low' | 'normal' | 'high' | 'urgent'>;
  /** Correspondent class — the split-inbox axis. */
  kind?: 'person' | 'unknown' | 'automated' | 'otp';
  /** Conversations containing a photo, any attachment, a voice memo, or a link. */
  has?: 'photo' | 'attachment' | 'voice' | 'link';
  /**
   * Any of these words in the latest message or the title (OR within the
   * list). Deliberately not the whole archive — see `buildConversationWhere`.
   */
  bodyContains?: string[];
  /** Only conversations past (or approaching) their SLA. */
  slaBreached?: boolean;
  unreadOnly?: boolean;
  /** They opened your last message and never wrote back. */
  readNoReply?: boolean;
  /** Only conversations the viewer pinned. */
  pinnedOnly?: boolean;
  /**
   * A custom AND/OR condition set, ANDed with the flat fields above.
   *
   * The flat fields stay because they map one-to-one onto the filter bar,
   * which is where most folders are born ("filter, then save"). The query is
   * for the folders you sit down and design.
   */
  query?: FolderQuery;
  sort?: 'newest' | 'oldest' | 'priority';
  /**
   * Marks a folder as one of the built-in split-inbox sections, so the
   * Workspace switches can find it again after it has been renamed or its
   * rule edited. Not a filter — evaluators must ignore it.
   */
  splitKey?: 'otp' | 'automated' | 'unknown' | 'important';
}

/**
 * A folder: a named filter with a place to live.
 *
 * Membership is COMPUTED, never filed. A folder created today already
 * contains all the history that matches it, a thread leaves the moment it
 * stops qualifying, and changing the rule needs no backfill — none of which
 * is true of the email folders this replaces.
 *
 * Personal by default; `isShared` promotes it to a team folder.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: text('id').primaryKey().$defaultFn(genId('view')),
    name: text('name').notNull(),
    /** Lucide icon name rendered in the sidebar. */
    icon: text('icon').notNull().default('Filter'),
    filters: jsonb('filters').$type<ViewFilters>().notNull().default({}),
    display: viewDisplay('display').notNull().default('sidebar'),
    isShared: boolean('is_shared').notNull().default(false),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (v) => [index('saved_views_owner_idx').on(v.ownerUserId)],
);

/**
 * A tag the AI keeps wanting to apply but which doesn't exist yet. Triage
 * records them here (with a running count) instead of silently dropping them;
 * an admin approves once and it becomes a real tag.
 */
export const tagSuggestions = pgTable(
  'tag_suggestions',
  {
    id: text('id').primaryKey().$defaultFn(genId('tsug')),
    name: text('name').notNull().unique(),
    /** How many conversations the AI wanted to apply this to. */
    count: integer('count').notNull().default(1),
    /** Set when an admin rejects the suggestion — never surfaced again. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('tag_suggestions_count_idx').on(t.count)],
);
