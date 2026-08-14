'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from '@comms/db';
import { conversationPins, resolvePreferences, users } from '@comms/db';
import { db } from '@/server/db';
import { requireWriter } from '@/lib/session';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Pins are personal.
 *
 * A shared inbox has one list and several people working it, so "float this
 * to the top" cannot be a column on the conversation — my pin would reorder
 * your inbox. It's a row in a join table keyed by (conversation, user), which
 * is also why it needs no workspace permission: nothing about the
 * conversation changes, only my view of it. `requireWriter` is still the
 * guard, since it is what stops a view-as session from rearranging somebody
 * else's inbox on their behalf.
 */
export async function togglePin(conversationId: string): Promise<
  { ok: true; pinned: boolean } | { ok: false; error: string }
> {
  const me = await requireWriter();

  const existing = await db.query.conversationPins.findFirst({
    where: and(
      eq(conversationPins.conversationId, conversationId),
      eq(conversationPins.userId, me.id),
    ),
  });

  if (existing) {
    await db
      .delete(conversationPins)
      .where(
        and(
          eq(conversationPins.conversationId, conversationId),
          eq(conversationPins.userId, me.id),
        ),
      );
  } else {
    await db
      .insert(conversationPins)
      .values({ conversationId, userId: me.id })
      // Two clicks racing each other shouldn't be an error toast.
      .onConflictDoNothing();
  }

  revalidatePath('/inbox');
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true, pinned: !existing };
}

/** Set the pin explicitly — what Undo calls to put a pin back. */
export async function setPinned(conversationId: string, pinned: boolean): Promise<ActionResult> {
  const me = await requireWriter();

  if (pinned) {
    await db
      .insert(conversationPins)
      .values({ conversationId, userId: me.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(conversationPins)
      .where(
        and(
          eq(conversationPins.conversationId, conversationId),
          eq(conversationPins.userId, me.id),
        ),
      );
  }

  revalidatePath('/inbox');
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}

/**
 * Clear pins on conversations that just got closed, for everyone who set the
 * `unpinOnDone` preference.
 *
 * Per-user, because the preference is: two people can pin the same thread and
 * only the one who asked for it loses their pin. Called from the close paths
 * rather than from a trigger so it stays visible next to the action that
 * causes it.
 */
export async function unpinClosedFor(conversationIds: string[]): Promise<void> {
  if (conversationIds.length === 0) return;

  const pins = await db.query.conversationPins.findMany({
    where: inArray(conversationPins.conversationId, conversationIds),
    columns: { conversationId: true, userId: true },
  });
  if (pins.length === 0) return;

  const owners = await db.query.users.findMany({
    where: inArray(users.id, Array.from(new Set(pins.map((p) => p.userId)))),
    columns: { id: true, preferences: true },
  });
  const wantsUnpin = new Set(
    owners.filter((u) => resolvePreferences(u.preferences).unpinOnDone).map((u) => u.id),
  );

  const doomed = pins.filter((p) => wantsUnpin.has(p.userId));
  for (const p of doomed) {
    await db
      .delete(conversationPins)
      .where(
        and(
          eq(conversationPins.conversationId, p.conversationId),
          eq(conversationPins.userId, p.userId),
        ),
      );
  }
}
