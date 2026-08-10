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
