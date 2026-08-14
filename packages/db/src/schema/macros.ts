import { pgTable, text, jsonb, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';
import { users } from './auth.js';

/** Conversation mutations a macro or automation can apply. Shared shape. */
export interface ConversationActions {
  setStatus?: 'open' | 'pending' | 'snoozed' | 'closed';
  setPriority?: 'low' | 'normal' | 'high' | 'urgent';
  assignToUserId?: string | null;
  addTagIds?: string[];
}

/**
 * A macro / canned response. `body` supports template variables like
 * {{contact.first_name}} and {{agent.name}} (rendered at insert time), and
 * `actions` mutate the conversation when the macro is applied — turning a
 * macro from a text snippet into a one-keystroke workflow.
 */
export const macros = pgTable('macros', {
  id: text('id').primaryKey().$defaultFn(genId('mac')),
  name: text('name').notNull(),
  /** Typed after `/` in the composer to insert this macro. */
  shortcut: text('shortcut'),
  body: text('body').notNull().default(''),
  actions: jsonb('actions').$type<ConversationActions>().notNull().default({}),
  isShared: boolean('is_shared').notNull().default(true),
  /** How many times this macro has been applied — reveals what the team says. */
  usageCount: integer('usage_count').notNull().default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});
