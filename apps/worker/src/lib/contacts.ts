import { getDb, eq, and, inArray, isNotNull, ne, sql } from '@comms/db';
import {
  contacts,
  contactIdentities,
  channelConnections,
  conversations,
  conversationParticipants,
} from '@comms/db';
import {
  type BBContact,
  normalizeAddress,
  addressMatchKey,
  isRealContactName,
  logger,
} from '@comms/core';
import { loadConnection } from './connection.js';

const log = logger.child({ module: 'contacts' });

/**
 * Guard against a malicious or corrupt avatar bloating the contacts table.
 *
 * A macOS address-book photo is typically 10–60KB. 512KB is generous for a
 * real one and small enough that a 10,000-contact workspace stays well inside
 * what Postgres handles comfortably (and TOAST compresses it further).
 */
const MAX_AVATAR_BYTES = 512 * 1024;

/** Base64 has no mime type attached, so sniff the signature. */
function avatarMimeOf(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/jpeg';
}

/** Best display name we can build from a BlueBubbles contact record. */
function displayNameOf(c: BBContact): string | null {
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return (c.displayName?.trim() || full || c.nickname?.trim() || null) ?? null;
}

/**
 * Every usable address on a contact.
 *
 * Tolerates both shapes: the documented `{ address }` objects and bare strings,
 * because getting this wrong fails silently — an empty address list means the
 * contact is skipped with no error anywhere.
 */
function addressesOf(c: BBContact) {
  const raw: unknown[] = [...(c.phoneNumbers ?? []), ...(c.emails ?? [])];
  return raw
    .map((a) => (typeof a === 'string' ? a : (a as { address?: string | null })?.address))
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => normalizeAddress(a));
}

/**
 * True when a contact's name is just its own address — i.e. a placeholder
 * created by `resolveContact()` during ingest, safe to overwrite with a real
 * name from the address book.
 *
 * The inverse of the classifier's test, and deliberately the same one: if the
 * two disagreed, a contact could be "named enough" to be filed as a person
 * while still being "unnamed enough" for the sync to overwrite.
 */
function isPlaceholderName(name: string | null, addresses: string[]): boolean {
  return !isRealContactName(name, addresses);
}

/**
 * Reset rows written before the empty-string fallthrough was fixed.
 *
 * BlueBubbles sends '' for any chat the user never named, and the old `??`
 * stored it verbatim — so the row renders unlabelled forever, because every
 * fallback downstream only triggers on null. Nulling those out lets the
 * naming helpers do their job.
 *
 * Idempotent and cheap (three indexed UPDATEs that match nothing once clean),
 * so it runs at worker boot rather than waiting on the hourly contact sync.
 */
export async function repairBlankNames(): Promise<void> {
  const db = getDb();
  const direct = await db
    .update(conversations)
    .set({ title: null })
    .where(and(eq(conversations.title, ''), eq(conversations.isGroup, false)))
    .returning({ id: conversations.id });
  const groups = await db
    .update(conversations)
    .set({ title: 'Group conversation' })
    .where(and(eq(conversations.title, ''), eq(conversations.isGroup, true)))
    .returning({ id: conversations.id });
  const named = await db
    .update(contacts)
    .set({ displayName: null })
    .where(eq(contacts.displayName, ''))
    .returning({ id: contacts.id });

  const total = direct.length + groups.length + named.length;
  // Silence is what made the original bug hard to see; say so either way.
  if (total > 0) {
    log.info(
      { conversations: direct.length, groups: groups.length, contacts: named.length },
      'repaired blank names',
    );
  } else {
    log.debug('no blank names to repair');
  }
}

/**
 * Move threads out of "Unknown numbers" once their contact has a real name.
 *
 * The classifier's first escape hatch is "a named contact is a person", but it
 * only ever ran on inbound traffic — so a number the address book named this
 * morning stayed filed under Unknown until they happened to text again, which
 * for a quiet contact is never. This closes that loop from the other side.
 *
 * Groups are excluded because they are always `person` anyway, and it never
 * touches `otp`/`automated`: those are earned from message content, and a
 * name on the sender doesn't make a verification code a conversation.
 */
async function reclassifyNamedContacts(): Promise<number> {
  const db = getDb();

  const candidates = await db
    .select({
      id: conversations.id,
      displayName: contacts.displayName,
      value: contactIdentities.value,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(contactIdentities, eq(contactIdentities.contactId, contacts.id))
    .where(
      and(
        eq(conversations.kind, 'unknown'),
        eq(conversations.isGroup, false),
        isNotNull(conversations.contactId),
      ),
    );

  // One contact can have several identities, so the join fans out; keep the
  // addresses per conversation and decide once.
  const byConversation = new Map<string, { displayName: string | null; addresses: string[] }>();
  for (const row of candidates) {
    const entry = byConversation.get(row.id) ?? { displayName: row.displayName, addresses: [] };
    if (row.value) entry.addresses.push(row.value);
    byConversation.set(row.id, entry);
  }

  const promote = Array.from(byConversation.entries())
    .filter(([, v]) => isRealContactName(v.displayName, v.addresses))
    .map(([id]) => id);
  if (promote.length === 0) return 0;

  await db
    .update(conversations)
    .set({ kind: 'person' })
    .where(and(inArray(conversations.id, promote), eq(conversations.kind, 'unknown')));
  log.info({ count: promote.length }, 'named contacts moved out of Unknown');
  return promote.length;
}

/**
 * Undo names that were the chat's, not the person's.
 *
 * Ingest used to pass the chat's display name when creating a contact for a
 * message author, so every new participant of a named group was christened
 * after the group. The sync could never correct it either: the name doesn't
 * look like an address, so `isPlaceholderName` calls it real and leaves it
 * alone. Blanking these lets the address book — or the address itself — take
 * over on the next pass.
 *
 * Narrow on purpose: only a contact whose name exactly matches the title of a
 * group they are actually in. Someone genuinely called "Book Club" who is in
 * a group chat called "Book Club" is a coincidence this will get wrong once,
 * and the fix is to type their name in.
 */
export async function repairChatNamedContacts(): Promise<number> {
  const db = getDb();
  const cleared = await db
    .update(contacts)
    .set({ displayName: null })
    .where(
      sql`exists (
        select 1
        from ${conversationParticipants} cp
        join ${contactIdentities} ci on ci.id = cp.contact_identity_id
        join ${conversations} conv on conv.id = cp.conversation_id
        where ci.contact_id = ${contacts.id}
          and conv.is_group = true
          and conv.title is not null
          and lower(btrim(conv.title)) = lower(btrim(${contacts.displayName}))
      )`,
    )
    .returning({ id: contacts.id });

  if (cleared.length) {
    log.info({ count: cleared.length }, 'cleared contacts named after their group chat');
  }
  return cleared.length;
}

export interface ContactSyncResult {
  fetched: number;
  /** Address-book entries that yielded at least one usable address. */
  withAddresses: number;
  enriched: number;
  created: number;
  skippedCollisions: number;
  skippedNoName: number;
  alreadyNamed: number;
  /** Photos stored this run — the number to look at when faces don't appear. */
  avatarsStored: number;
  /** Threads moved out of "Unknown" because their contact now has a name. */
  reclassified: number;
  macContactsVisible: boolean;
}

/**
 * Pull the Mac's address book into Comms.
 *
 * Merge policy, deliberately conservative: we ENRICH existing contacts (fill
 * in a real name/avatar where we only had a phone number) and CREATE contacts
 * for addresses we've never seen. We never merge two existing Comms contacts
 * together — that's destructive and unreversible, so collisions are counted
 * and logged for a future manual-merge UI instead.
 */
export async function syncContacts(connectionId: string): Promise<ContactSyncResult> {
  const db = getDb();
  const { client } = await loadConnection(connectionId);

  // Two passes: the roster is fast, avatars are slow (base64-inlined), so they
  // come in batches rather than one enormous request that would time out.
  const roster = await client.listContacts({ withAvatars: false });
  // Log one anonymised sample so a shape mismatch is diagnosable from logs
  // rather than showing up as "nothing synced and no error".
  const sample = roster[0];
  log.info(
    {
      connectionId,
      count: roster.length,
      sampleKeys: sample ? Object.keys(sample) : [],
      samplePhoneShape: Array.isArray(sample?.phoneNumbers)
        ? typeof sample.phoneNumbers[0]
        : typeof sample?.phoneNumbers,
    },
    'contact roster fetched',
  );

  const result: ContactSyncResult = {
    fetched: roster.length,
    withAddresses: 0,
    enriched: 0,
    created: 0,
    skippedCollisions: 0,
    skippedNoName: 0,
    alreadyNamed: 0,
    avatarsStored: 0,
    reclassified: 0,
    // If macOS Contacts permission was never granted, the 'api' half is empty
    // and we'd silently sync almost nothing — surface that to the operator.
    macContactsVisible: roster.some((c) => c.sourceType === 'api'),
  };

  // Dedupe by MATCH KEY, not by the stored value: iMessage gives E.164 while
  // the address book gives national format, so exact comparison silently
  // matches almost nothing. Prefer the macOS ('api') record — it's the one
  // carrying nickname/birthday.
  const byKey = new Map<string, { contact: BBContact; address: ReturnType<typeof normalizeAddress> }>();
  for (const c of roster) {
    const addrs = addressesOf(c);
    if (addrs.length > 0) result.withAddresses += 1;
    for (const addr of addrs) {
      const key = addressMatchKey(addr);
      const existing = byKey.get(key);
      if (!existing || (c.sourceType === 'api' && existing.contact.sourceType !== 'api')) {
        byKey.set(key, { contact: c, address: addr });
      }
    }
  }

  // Load every identity we already have and index it by the same match key.
  // (Cheaper and more reliable than a huge IN list of values that wouldn't
  // match anyway.)
  const known = await db
    .select({
      value: contactIdentities.value,
      kind: contactIdentities.kind,
      contactId: contactIdentities.contactId,
      displayName: contacts.displayName,
      // Presence, not the bytes: pulling every avatar into memory to decide
      // whether to fetch avatars would defeat the point.
      hasAvatar: sql<boolean>`${contacts.avatarData} is not null`,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId));

  const knownByKey = new Map<string, (typeof known)[number]>();
  for (const k of known) {
    knownByKey.set(addressMatchKey({ kind: k.kind, value: k.value, raw: k.value }), k);
  }

  // Avatars only for contacts we'll actually touch, in batches of 50.
  const wantAvatars = Array.from(byKey.entries())
    .filter(([key, entry]) => {
      const k = knownByKey.get(key);
      if (!k) return true; // new contact
      // Keyed on avatarData, not avatarUrl: rows synced before avatars moved
      // into the database have a URL pointing at an S3 object this install may
      // have no way to read, and would otherwise never be refetched.
      return !k.hasAvatar || isPlaceholderName(k.displayName, [entry.address.value]);
    })
    .map(([, entry]) => entry.address.raw);

  // Unconditional. This used to be gated on object storage being configured,
  // which meant an install without an S3 bucket showed initials for every
  // contact in the product, permanently and with no error anywhere.
  const avatarByAddress = new Map<string, string>();
  if (wantAvatars.length) {
    for (let i = 0; i < wantAvatars.length; i += 50) {
      const batch = wantAvatars.slice(i, i + 50);
      try {
        const detailed = await client.queryContacts(batch, { withAvatars: true });
        for (const c of detailed) {
          if (!c.avatar) continue;
          for (const a of addressesOf(c)) avatarByAddress.set(addressMatchKey(a), c.avatar);
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'avatar batch failed; continuing without');
      }
    }
  }

  /**
   * The columns that put a face on a contact, or null if the photo is
   * unusable. Decoding first is the size check — base64 overstates the real
   * byte count by a third.
   */
  function avatarPatch(base64: string): { avatarData: string; avatarMime: string } | null {
    const bytes = Buffer.byteLength(base64, 'base64');
    if (bytes === 0 || bytes > MAX_AVATAR_BYTES) return null;
    return { avatarData: base64, avatarMime: avatarMimeOf(base64) };
  }

  const now = new Date();

  for (const [key, { contact: bb, address: norm }] of byKey) {
    const name = displayNameOf(bb);
    const existing = knownByKey.get(key);

    if (existing) {
      const patch: Partial<typeof contacts.$inferInsert> = { syncedAt: now };
      // Only overwrite a name that's really just the raw address.
      if (name && isPlaceholderName(existing.displayName, [existing.value, norm.value])) {
        patch.displayName = name;
      } else if (name) {
        result.alreadyNamed += 1;
      }
      if (!existing.hasAvatar && avatarByAddress.has(key)) {
        const avatar = avatarPatch(avatarByAddress.get(key)!);
        if (avatar) {
          patch.avatarData = avatar.avatarData;
          patch.avatarMime = avatar.avatarMime;
          patch.avatarUrl = `/api/avatars/${existing.contactId}`;
          result.avatarsStored += 1;
        }
      }
      if (Object.keys(patch).length > 1) {
        await db.update(contacts).set(patch).where(eq(contacts.id, existing.contactId));
        result.enriched += 1;
      }
      continue;
    }

    // Unknown address → create a contact, unless one of this person's OTHER
    // addresses already maps to a Comms contact (in which case just attach).
    const siblings = addressesOf(bb)
      .map((a) => knownByKey.get(addressMatchKey(a))?.contactId)
      .filter((id): id is string => Boolean(id));
    const uniqueSiblings = Array.from(new Set(siblings));

    if (uniqueSiblings.length > 1) {
      // This address book entry spans two existing Comms contacts. Merging
      // them automatically would be destructive — leave for a manual UI.
      result.skippedCollisions += 1;
      log.info({ key, contactIds: uniqueSiblings }, 'contact collision; not auto-merging');
      continue;
    }

    let contactId = uniqueSiblings[0];
    if (!contactId) {
      if (!name) {
        result.skippedNoName += 1;
        continue; // nothing worth creating a record for
      }
      const [created] = await db
        .insert(contacts)
        .values({ displayName: name, syncedAt: now })
        .returning({ id: contacts.id });
      if (!created) continue;
      contactId = created.id;
      result.created += 1;

      const raw = avatarByAddress.get(key);
      const avatar = raw ? avatarPatch(raw) : null;
      if (avatar) {
        await db
          .update(contacts)
          .set({ ...avatar, avatarUrl: `/api/avatars/${contactId}` })
          .where(eq(contacts.id, contactId));
        result.avatarsStored += 1;
      }
    }

    await db
      .insert(contactIdentities)
      .values({ contactId, kind: norm.kind, value: norm.value, rawValue: norm.raw })
      .onConflictDoNothing();
    // Newly attached identity — keep the index current for later iterations.
    knownByKey.set(key, {
      value: norm.value,
      kind: norm.kind,
      contactId,
      displayName: name,
      hasAvatar: Boolean(avatarByAddress.get(key)),
    });
  }

  await repairBlankNames();
  result.reclassified = await reclassifyNamedContacts();

  await db
    .update(channelConnections)
    .set({ contactsSyncedAt: now })
    .where(eq(channelConnections.id, connectionId));

  log.info({ connectionId, ...result }, 'contact sync complete');
  return result;
}
