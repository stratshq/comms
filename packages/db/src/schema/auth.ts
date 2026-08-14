import { pgTable, text, timestamp, primaryKey, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';
import { userStatus } from './enums.js';
import { roles, AGENT_ROLE_ID } from './roles.js';

/**
 * Per-user settings, owned by the user rather than by an admin. Everything is
 * optional so an unset key can fall back to the product default — see
 * `notificationDefaults` for what those are.
 */
export interface UserPreferences {
  /** In-app notification when a teammate @mentions you in an internal note. */
  notifyMentions?: boolean;
  /** Play a short tone when a new notification lands while the app is open. */
  notificationSound?: boolean;
  /**
   * Personal signature appended to outbound replies. Takes precedence over
   * the inbox signature; both are inert unless the workspace has signatures
   * enabled. Empty/unset means "no personal signature".
   */
  signature?: string;
  /**
   * Keyboard shortcuts. Stored as a preset plus a diff rather than a full map,
   * so an action added in a later version picks up its default instead of
   * silently having no binding.
   *
   * The shapes live in the web app (`@/lib/keymap`); the database only needs
   * to carry them, so they stay loose here.
   */
  keymap?: {
    preset?: string;
    overrides?: Record<string, string[]>;
    enterSends?: boolean;
  };
}

/** Defaults applied when a user has never touched their notification settings. */
export const notificationDefaults = {
  notifyMentions: true,
  notificationSound: false,
} satisfies Omit<Required<UserPreferences>, 'keymap' | 'signature'>;

/** Read a user's preferences with the defaults filled in for anything unset. */
export function resolvePreferences(
  preferences: UserPreferences | null | undefined,
): Omit<Required<UserPreferences>, 'keymap' | 'signature'> &
  Pick<UserPreferences, 'keymap' | 'signature'> {
  return { ...notificationDefaults, ...(preferences ?? {}) };
}

/**
 * Users table. Compatible with the Auth.js Drizzle adapter (id/name/email/
 * emailVerified/image) and extended with Comms-specific columns. `hashedPassword`
 * is null for users who only use OAuth or magic-link sign-in.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(genId('usr')),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
  image: text('image'),
  hashedPassword: text('hashed_password'),
  roleId: text('role_id')
    .notNull()
    .default(AGENT_ROLE_ID)
    .references(() => roles.id),
  status: userStatus('status').notNull().default('active'),
  preferences: jsonb('preferences').$type<UserPreferences>().notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  ...timestamps,
});

/** OAuth provider accounts linked to a user (Auth.js adapter shape). */
export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

/** Database sessions (Auth.js adapter shape). Used for OAuth / magic-link flows. */
export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
});

/** Verification tokens for magic-link email sign-in (Auth.js adapter shape). */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/** Pending teammate invitations. Accepting one provisions a user. */
export const invites = pgTable('invites', {
  id: text('id').primaryKey().$defaultFn(genId('inv')),
  email: text('email').notNull(),
  roleId: text('role_id').notNull().default(AGENT_ROLE_ID),
  token: text('token').notNull().unique(),
  invitedByUserId: text('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revoked: boolean('revoked').notNull().default(false),
  ...timestamps,
});
