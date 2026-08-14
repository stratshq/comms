'use server';

import { revalidatePath } from 'next/cache';
import { eq, inArray } from '@comms/db';
import { bundles, conversations } from '@comms/db';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';
import { getSetting, setSetting } from '@/server/settings';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Bundle names the team has dissolved. The AI is told never to recreate
 * these — without the list, an unwanted bundle would reappear on the next
 * sweep and "dissolve" would be a lie.
 */
export async function dismissedBundleNames(): Promise<string[]> {
  return (await getSetting<string[]>('bundles_dismissed')) ?? [];
}

export type DissolveResult =
  | { ok: true; name: string; conversationIds: string[] }
  | { ok: false; error: string };

/**
 * Dissolve a bundle: unassign its conversations, delete it, and remember the
 * name so the AI doesn't rebuild it. Returns what was undone so the caller
 * can offer a real Undo.
 */
export async function dissolveBundle(bundleId: string): Promise<DissolveResult> {
  await requireWriter();
  const bundle = await db.query.bundles.findFirst({ where: eq(bundles.id, bundleId) });
  if (!bundle) return { ok: false, error: 'Bundle not found.' };

  const members = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.bundleId, bundleId));

  await db.delete(bundles).where(eq(bundles.id, bundleId));

  const dismissed = await dismissedBundleNames();
  if (!dismissed.includes(bundle.name)) {
    await setSetting('bundles_dismissed', [...dismissed, bundle.name].slice(-50));
  }

  revalidatePath('/inbox');
  return { ok: true, name: bundle.name, conversationIds: members.map((m) => m.id) };
}

/** Undo a dissolve: recreate the bundle and put its conversations back. */
export async function restoreBundle(
  name: string,
  conversationIds: string[],
): Promise<ActionResult> {
  await requireWriter();
  const [bundle] = await db
    .insert(bundles)
    .values({ name })
    .onConflictDoUpdate({ target: bundles.name, set: { updatedAt: new Date() } })
    .returning();
  if (!bundle) return { ok: false, error: 'Could not restore the bundle.' };

  if (conversationIds.length) {
    await db
      .update(conversations)
      .set({ bundleId: bundle.id })
      .where(inArray(conversations.id, conversationIds));
  }

  const dismissed = await dismissedBundleNames();
  await setSetting(
    'bundles_dismissed',
    dismissed.filter((n) => n !== name),
  );

  revalidatePath('/inbox');
  return { ok: true };
}

/** Take one conversation out of its bundle (it won't be re-added this sweep cycle). */
export async function removeFromBundle(conversationId: string): Promise<ActionResult> {
  await requireWriter();
  await db
    .update(conversations)
    .set({ bundleId: null })
    .where(eq(conversations.id, conversationId));
  revalidatePath('/inbox');
  return { ok: true };
}
