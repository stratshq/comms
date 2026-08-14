'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from '@comms/db';
import { contacts, contactIdentities } from '@comms/db';
import { normalizeAddress } from '@comms/core';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Name (or rename) a contact — the one-click follow-through on the Instant
 * Intro card's "they introduced themselves as…". Company is optional and only
 * ever fills a blank; a synced address book stays the authority on its own
 * fields.
 */
export async function nameContact(input: {
  contactId: string;
  name: string;
  company?: string | null;
}): Promise<ActionResult> {
  await requireWriter();
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length > 80) return { ok: false, error: 'Name must be 80 characters or fewer.' };

  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, input.contactId) });
  if (!contact) return { ok: false, error: 'Contact not found.' };

  await db
    .update(contacts)
    .set({
      displayName: name,
      ...(input.company?.trim() && !contact.company ? { company: input.company.trim() } : {}),
    })
    .where(eq(contacts.id, input.contactId));

  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}

/**
 * Free-form facts about a client, edited straight from the details panel.
 * Notes and company have had columns since the first migration; this is the
 * first UI that can write them.
 */
export async function updateContactDetails(input: {
  contactId: string;
  notes?: string | null;
  company?: string | null;
}): Promise<ActionResult> {
  await requireUser();
  const patch: { notes?: string | null; company?: string | null } = {};
  if (input.notes !== undefined) patch.notes = input.notes?.trim().slice(0, 4000) || null;
  if (input.company !== undefined) patch.company = input.company?.trim().slice(0, 120) || null;
  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(contacts).set(patch).where(eq(contacts.id, input.contactId));
  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}

/**
 * Custom fields: the `attributes` jsonb has existed unused since the first
 * schema — "track more things" is exactly what it was for. Empty value
 * deletes the key.
 */
export async function setContactAttribute(input: {
  contactId: string;
  key: string;
  value: string;
}): Promise<ActionResult> {
  await requireUser();
  const key = input.key.trim().slice(0, 40);
  if (!key) return { ok: false, error: 'Field name is required.' };

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, input.contactId),
    columns: { attributes: true },
  });
  if (!contact) return { ok: false, error: 'Contact not found.' };

  const attributes = { ...(contact.attributes ?? {}) };
  const value = input.value.trim().slice(0, 500);
  if (value) attributes[key] = value;
  else delete attributes[key];

  if (Object.keys(attributes).length > 30) {
    return { ok: false, error: 'That is enough custom fields for one human.' };
  }

  await db.update(contacts).set({ attributes }).where(eq(contacts.id, input.contactId));
  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}

/**
 * Attach another address to a person.
 *
 * The same human texts from a work number and a personal one, and until both
 * point at one contact they are two strangers to the product. The unique
 * constraint on (kind, value) is what makes this safe: an address already
 * claimed elsewhere is reported rather than silently stolen, since moving it
 * would quietly empty out the other person's history.
 */
export async function addContactIdentity(input: {
  contactId: string;
  address: string;
}): Promise<ActionResult> {
  await requireWriter();
  const raw = input.address.trim();
  if (!raw) return { ok: false, error: 'Enter a phone number or email.' };

  // `normalizeAddress` never fails — anything it can't parse comes back as an
  // opaque 'handle'. For something a person typed, that means a typo.
  const norm = normalizeAddress(raw);
  if (norm.kind === 'handle') {
    return { ok: false, error: 'That does not look like a phone number or email.' };
  }

  const taken = await db.query.contactIdentities.findFirst({
    where: and(eq(contactIdentities.kind, norm.kind), eq(contactIdentities.value, norm.value)),
    columns: { contactId: true },
  });
  if (taken) {
    return taken.contactId === input.contactId
      ? { ok: false, error: 'They already have that address.' }
      : { ok: false, error: 'Another contact already uses that address.' };
  }

  await db.insert(contactIdentities).values({
    contactId: input.contactId,
    kind: norm.kind,
    value: norm.value,
    rawValue: norm.raw,
  });

  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}

/**
 * Detach an address.
 *
 * Refused for the last one: a contact with no addresses is unreachable and
 * unmatchable, so every future message from them would build a fresh
 * duplicate contact instead of finding this one.
 */
export async function removeContactIdentity(input: {
  contactId: string;
  identityId: string;
}): Promise<ActionResult> {
  await requireWriter();

  const rows = await db
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(eq(contactIdentities.contactId, input.contactId));
  if (rows.length <= 1) {
    return { ok: false, error: 'A contact needs at least one address.' };
  }

  await db
    .delete(contactIdentities)
    .where(
      and(
        eq(contactIdentities.id, input.identityId),
        eq(contactIdentities.contactId, input.contactId),
      ),
    );

  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}

/**
 * Opt a contact out of outbound messages, or back in.
 *
 * The column has been enforced since the first release — `sendMessage`, the
 * outbound worker and automations all refuse to send to an opted-out contact
 * — but nothing could read or set it, so the only way to discover the state
 * was to try to send and be refused. Replying STOP still sets it
 * automatically; this is the manual lever beside it.
 */
export async function setContactOptOut(input: {
  contactId: string;
  optedOut: boolean;
}): Promise<ActionResult> {
  await requireWriter();
  await db
    .update(contacts)
    .set({ optedOutAt: input.optedOut ? new Date() : null })
    .where(eq(contacts.id, input.contactId));

  revalidatePath('/inbox');
  revalidatePath(`/people/${input.contactId}`);
  return { ok: true };
}
