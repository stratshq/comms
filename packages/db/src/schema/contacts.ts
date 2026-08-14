import { pgTable, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';
import { identityKind } from './enums.js';

/** A person the team communicates with. Aggregates one or more identities. */
export const contacts = pgTable(
  'contacts',
  {
  id: text('id').primaryKey().$defaultFn(genId('cont')),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  company: text('company'),
  notes: text('notes'),
  /** Arbitrary structured attributes shown on the contact panel. */
  attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
  /**
   * Set when the contact replies STOP (or a synonym): outbound sends to them
   * are blocked until they reply START. TCPA compliance — never bypass this.
   */
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  /** Last time the Mac's address book enriched this record. */
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  /**
   * Legacy: S3 key for a synced address-book photo. Still served for installs
   * that synced before avatars moved into the database, but nothing writes it
   * any more — see `avatarData`.
   */
  avatarStorageKey: text('avatar_storage_key'),
  /**
   * The address-book photo itself, base64, exactly as BlueBubbles hands it
   * over.
   *
   * In the database rather than object storage because a contact photo is a
   * few KB and an inbox where nobody has a face is materially worse to use.
   * Gating that on an S3 bucket meant every install without one showed
   * initials for every person forever, with nothing anywhere saying why.
   * Attachments are a different matter and stay in object storage.
   */
  avatarData: text('avatar_data'),
  /** Mime type for `avatarData`, sniffed from the bytes. */
  avatarMime: text('avatar_mime'),
  ...timestamps,
  },
);

/**
 * A reachable address for a contact (phone, email, or raw iMessage handle).
 * `value` is normalized (E.164 for phones, lowercased email). Maps inbound
 * BlueBubbles handle addresses to a contact.
 */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: text('id').primaryKey().$defaultFn(genId('idn')),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: identityKind('kind').notNull(),
    value: text('value').notNull(),
    /** The raw address as BlueBubbles reported it, before normalization. */
    rawValue: text('raw_value'),
    ...timestamps,
  },
  (ci) => [unique('contact_identities_kind_value_unq').on(ci.kind, ci.value)],
);
