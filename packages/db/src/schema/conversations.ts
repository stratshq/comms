import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';
import { channelType, conversationKind, conversationStatus, priority } from './enums.js';
import { inboxes } from './inboxes.js';
import { contacts, contactIdentities } from './contacts.js';
import { users } from './auth.js';

/**
 * An AI-maintained grouping of similar active conversations ("Order updates",
 * "Scheduling", …). Unlike a tag, a bundle is decided by the model rather than
 * built by hand, and membership is a single slot: a conversation belongs to at
 * most one bundle, because the list can only group a row under one header.
 */
export const bundles = pgTable('bundles', {
  id: text('id').primaryKey().$defaultFn(genId('bndl')),
  name: text('name').notNull().unique(),
  ...timestamps,
});

/**
 * A conversation thread. In Comms a conversation *is* the ticket — it carries
 * status, assignee, priority and a human ticket `number`.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey().$defaultFn(genId('conv')),
    /** Human-friendly ticket number, e.g. #1042. */
    number: integer('number').generatedAlwaysAsIdentity(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    channelType: channelType('channel_type').notNull().default('imessage'),
    /** The BlueBubbles chat GUID, e.g. `iMessage;-;+15551234567`. Reused verbatim for sends. */
    providerChatGuid: text('provider_chat_guid').notNull(),
    isGroup: boolean('is_group').notNull().default(false),
    title: text('title'),

    // Ticket attributes
    status: conversationStatus('status').notNull().default('open'),
    priority: priority('priority').notNull().default('normal'),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    /**
     * "Bump this back to me if the customer hasn't replied by then." Unlike a
     * snooze it resolves silently when `lastInboundAt` moves past
     * `followUpArmedAt` — you're only reminded about actual silence.
     */
    followUpAt: timestamp('follow_up_at', { withTimezone: true }),
    followUpArmedAt: timestamp('follow_up_armed_at', { withTimezone: true }),
    followUpUserId: text('follow_up_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Muted: the thread stays exactly where it is, but stops demanding
     * attention — no unread badge, no notification sound. Permanent until
     * unmuted, which is what makes it different from a snooze: a snooze hides
     * and comes back; a mute stays visible and stays quiet. Group chats are
     * the reason this exists.
     */
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    /** AI-assigned bundle (see `bundles`). Null = not grouped. */
    bundleId: text('bundle_id').references(() => bundles.id, { onDelete: 'set null' }),
    /**
     * Correspondent class, re-evaluated on inbound traffic. Drives the split
     * inbox and the OTP affordances; never blocks anything, because a
     * misclassified customer must still be reachable.
     */
    kind: conversationKind('kind').notNull().default('person'),

    // Activity denormalizations for fast list rendering
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    unreadCount: integer('unread_count').notNull().default(0),

    // SLA / metrics
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    nextResponseDueAt: timestamp('next_response_due_at', { withTimezone: true }),
    slaBreachedAt: timestamp('sla_breached_at', { withTimezone: true }),
    csatScore: integer('csat_score'),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (c) => [
    unique('conversations_inbox_chat_guid_unq').on(c.inboxId, c.providerChatGuid),
    index('conversations_status_idx').on(c.status),
    index('conversations_assignee_idx').on(c.assigneeId),
    index('conversations_last_message_idx').on(c.lastMessageAt),
    // A folder axis, queried on every list render and every count.
    index('conversations_kind_idx').on(c.kind),
  ],
);

/** Participants of a (group) conversation, by contact identity. */
export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    contactIdentityId: text('contact_identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
  },
  (cp) => [primaryKey({ columns: [cp.conversationId, cp.contactIdentityId] })],
);

export const tags = pgTable('tags', {
  id: text('id').primaryKey().$defaultFn(genId('tag')),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#71717a'),
  ...timestamps,
});

export const conversationTags = pgTable(
  'conversation_tags',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (ct) => [primaryKey({ columns: [ct.conversationId, ct.tagId] })],
);
