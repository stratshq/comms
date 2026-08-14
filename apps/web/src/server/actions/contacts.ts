'use server';

import { revalidatePath } from 'next/cache';
import { eq } from '@comms/db';
import { contacts } from '@comms/db';
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
  return { ok: true };
}
