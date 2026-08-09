import { pgEnum } from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'invited', 'disabled']);

/** The transport family of a conversation. Extensible: whatsapp, sms, etc. later. */
export const channelType = pgEnum('channel_type', ['imessage']);

/** Concrete integration provider behind a channel. */
export const channelProvider = pgEnum('channel_provider', ['bluebubbles']);

export const connectionStatus = pgEnum('connection_status', [
  'pending',
  'connected',
  'disconnected',
  'error',
]);

/** Ticket lifecycle, applied directly to a conversation (a conversation IS the ticket). */
export const conversationStatus = pgEnum('conversation_status', [
  'open',
  'pending',
  'snoozed',
  'closed',
]);

export const priority = pgEnum('priority', ['low', 'normal', 'high', 'urgent']);

/**
 * What KIND of correspondent this thread is with — the axis a split inbox
 * divides on. Detected from traffic rather than declared: a business number
 * receives far more verification codes and delivery notices than it does
 * customers, and mixing those into one list is what makes the list useless.
 */
export const conversationKind = pgEnum('conversation_kind', [
  /** A named human we have context on. The default, and the only one that matters. */
  'person',
  /** Nobody we know yet. Feeds the screener. */
  'unknown',
  /** One-way machine traffic: delivery notices, appointment reminders, alerts. */
  'automated',
  /** Verification / 2FA codes. Read once, never replied to, disposable. */
  'otp',
]);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);

export const messageAuthorType = pgEnum('message_author_type', [
  'contact', // the customer
  'agent', // a Comms user
  'system', // generated timeline events (assigned, closed, …)
  'external', // sent from the Mac/iPhone outside Comms (echo with no tempGuid)
]);

export const messageStatus = pgEnum('message_status', [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
]);

/** How we can reach a contact. */
export const identityKind = pgEnum('identity_kind', ['phone', 'email', 'handle']);

export const attachmentStatus = pgEnum('attachment_status', ['pending', 'stored', 'failed']);
