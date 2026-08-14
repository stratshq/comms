'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, isNotNull, sql } from '@comms/db';
import { conversations, messages } from '@comms/db';
import { enqueueOutbound, outboundQueue } from '@comms/core';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';
import { getConnectionForInbox } from '@/server/queries';
import { conversationName } from '@/lib/naming';

/**
 * Everything with a future timestamp, in one place.
 *
 * Scheduling something and then having no screen that shows it is the part
 * that makes people stop trusting the feature — a message you cannot see is a
 * message you have to remember, which is exactly what scheduling was for.
 */

export type PendingKind = 'send' | 'reminder' | 'snooze';

export interface PendingItem {
  kind: PendingKind;
  /** Message id for a send; conversation id for a reminder or snooze. */
  id: string;
  conversationId: string;
  conversationName: string;
  /** The message body for a send; null otherwise. */
  body: string | null;
  dueAt: string;
}

type ActionResult = { ok: true } | { ok: false; error: string };

export async function listPending(): Promise<PendingItem[]> {
  await requireUser();

  const [sends, reminders, snoozes] = await Promise.all([
    db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        body: messages.body,
        dueAt: messages.scheduledFor,
        title: conversations.title,
        isGroup: conversations.isGroup,
        chatGuid: conversations.providerChatGuid,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(isNotNull(messages.scheduledFor), eq(messages.status, 'queued')))
      .orderBy(asc(messages.scheduledFor))
      .limit(200),

    db
      .select({
        id: conversations.id,
        dueAt: conversations.followUpAt,
        title: conversations.title,
        isGroup: conversations.isGroup,
        chatGuid: conversations.providerChatGuid,
      })
      .from(conversations)
      .where(isNotNull(conversations.followUpAt))
      .orderBy(asc(conversations.followUpAt))
      .limit(200),

    db
      .select({
        id: conversations.id,
        dueAt: conversations.snoozedUntil,
        title: conversations.title,
        isGroup: conversations.isGroup,
        chatGuid: conversations.providerChatGuid,
      })
      .from(conversations)
      .where(and(eq(conversations.status, 'snoozed'), isNotNull(conversations.snoozedUntil)))
      .orderBy(asc(conversations.snoozedUntil))
      .limit(200),
  ]);

  const name = (r: { title: string | null; isGroup: boolean; chatGuid: string }) =>
    conversationName({ title: r.title, isGroup: r.isGroup, chatGuid: r.chatGuid });

  const items: PendingItem[] = [
    ...sends.map((r) => ({
      kind: 'send' as const,
      id: r.id,
      conversationId: r.conversationId,
      conversationName: name(r),
      body: r.body,
      dueAt: r.dueAt!.toISOString(),
    })),
    ...reminders.map((r) => ({
      kind: 'reminder' as const,
      id: r.id,
      conversationId: r.id,
      conversationName: name(r),
      body: null,
      dueAt: r.dueAt!.toISOString(),
    })),
    ...snoozes.map((r) => ({
      kind: 'snooze' as const,
      id: r.id,
      conversationId: r.id,
      conversationName: name(r),
      body: null,
      dueAt: r.dueAt!.toISOString(),
    })),
  ];

  // Soonest first across all three kinds — the question is "what happens next",
  // not "what kind of thing is it".
  return items.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/**
 * Move a scheduled send to a new time.
 *
 * The delayed BullMQ job is keyed by message id, so rescheduling means
 * removing and re-adding it. The remove is checked: if the worker already
 * claimed the job the message is on its way and the new time is a lie.
 */
export async function rescheduleMessage(
  messageId: string,
  atIso: string,
): Promise<ActionResult> {
  const user = await requireWriter();
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'That is not a valid time.' };
  if (at.getTime() <= Date.now()) return { ok: false, error: 'Pick a time in the future.' };

  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!msg) return { ok: false, error: 'Message not found.' };
  if (msg.authorUserId !== user.id) {
    return { ok: false, error: 'Only the sender can reschedule.' };
  }
  if (msg.status !== 'queued') return { ok: false, error: 'Too late — already sent.' };

  // Everything that can fail happens BEFORE the job is removed. Removing first
  // and then bailing would leave the message stuck in 'queued' with nothing
  // scheduled to send it — a message that silently never goes out.
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, msg.conversationId),
  });
  const connection = conv ? await getConnectionForInbox(conv.inboxId) : null;
  if (!conv || !connection) {
    return { ok: false, error: 'This conversation has no connected number.' };
  }

  const removed = await outboundQueue()
    .remove(messageId)
    .catch(() => 0);
  if (!removed) return { ok: false, error: 'Too late — already sending.' };

  await db.update(messages).set({ scheduledFor: at }).where(eq(messages.id, messageId));
  await enqueueOutbound(
    { messageId, conversationId: conv.id, connectionId: connection.id },
    { jobId: messageId, delay: Math.max(at.getTime() - Date.now(), 0) },
  );

  revalidatePath('/scheduled');
  revalidatePath(`/inbox/${msg.conversationId}`);
  return { ok: true };
}

/** Move a snooze or a follow-up reminder to a new time. */
export async function rescheduleConversation(
  conversationId: string,
  kind: 'reminder' | 'snooze',
  atIso: string | null,
): Promise<ActionResult> {
  const user = await requireWriter();
  const at = atIso ? new Date(atIso) : null;
  if (at && Number.isNaN(at.getTime())) return { ok: false, error: 'That is not a valid time.' };
  if (at && at.getTime() <= Date.now()) return { ok: false, error: 'Pick a time in the future.' };

  if (kind === 'reminder') {
    await db
      .update(conversations)
      .set({
        followUpAt: at,
        // Re-arming resets the "did they reply since I asked" clock; keeping
        // the old armed time would resolve the reminder against a reply that
        // arrived before it was set.
        followUpArmedAt: at ? new Date() : null,
        followUpUserId: at ? user.id : null,
      })
      .where(eq(conversations.id, conversationId));
  } else {
    await db
      .update(conversations)
      .set(
        at
          ? { snoozedUntil: at, status: 'snoozed' as const }
          : // Cancelling a snooze wakes the conversation now, rather than
            // leaving it in a snoozed state with no wake time.
            { snoozedUntil: null, status: 'open' as const },
      )
      .where(eq(conversations.id, conversationId));
  }

  revalidatePath('/scheduled');
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}

/** Counts for the sidebar badge. */
export async function pendingCount(): Promise<number> {
  await requireUser();
  // Two plain counts rather than one expression over a synthetic FROM — the
  // clever version depended on how the query builder renders a bare subselect.
  const [sends, reminders] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(isNotNull(messages.scheduledFor), eq(messages.status, 'queued'))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(conversations)
      .where(isNotNull(conversations.followUpAt)),
  ]);
  return Number(sends[0]?.n ?? 0) + Number(reminders[0]?.n ?? 0);
}
