'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, inArray } from '@comms/db';
import {
  conversations,
  messages,
  conversationTags,
  users,
  notifications,
  inboxes,
  contacts,
  resolvePreferences,
  getRuntimeOverrides,
} from '@comms/db';
import {
  newTempGuid,
  enqueueOutbound,
  outboundQueue,
  publishEvent,
  loadConfig,
} from '@comms/core';
import { desc } from '@comms/db';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';
import { getConnectionForInbox } from '@/server/queries';
import { unpinClosedFor } from '@/server/actions/pins';
import { appendSignature, resolveSignature } from '@/server/signature';

export type ActionResult = { ok: true } | { ok: false; error: string };

export type SendResult =
  | { ok: true; messageId: string; undoMs: number }
  | { ok: false; error: string };

/** Parse @mentions in an internal note and notify matched teammates. */
async function notifyMentions(
  conversationId: string,
  body: string,
  authorUserId: string,
  authorName: string,
) {
  const tokens = Array.from(body.matchAll(/@([\w.+-]+)/g)).map((m) => m[1]!.toLowerCase());
  if (tokens.length === 0) return;

  const all = await db.query.users.findMany({
    where: eq(users.status, 'active'),
    columns: { id: true, name: true, email: true, preferences: true },
  });
  const matched = new Set<string>();
  for (const u of all) {
    if (u.id === authorUserId) continue;
    // Respect the recipient's own notification settings.
    if (!resolvePreferences(u.preferences).notifyMentions) continue;
    const nameKey = (u.name ?? '').toLowerCase().replace(/\s+/g, '');
    const emailLocal = u.email.split('@')[0]!.toLowerCase();
    if (tokens.some((t) => t === nameKey || t === emailLocal || t === u.email.toLowerCase())) {
      matched.add(u.id);
    }
  }
  for (const userId of matched) {
    await db.insert(notifications).values({
      userId,
      type: 'mention',
      conversationId,
      actorUserId: authorUserId,
      body: `${authorName} mentioned you in a note`,
    });
    await publishEvent({ type: 'notification', userId });
  }
}

/** Send a reply (queued for the worker) or save an internal note. */
export async function sendMessage(input: {
  conversationId: string;
  body: string;
  isPrivateNote?: boolean;
  replyToMessageGuid?: string;
  /** ISO timestamp to deliberately delay delivery until (scheduled send). */
  scheduledFor?: string;
  /**
   * When approving a teammate's shared draft, who actually wrote the words.
   * Display metadata only — the sender of record is always the caller.
   */
  draftedByUserId?: string;
}): Promise<SendResult> {
  const user = await requireWriter();
  let body = input.body.trim();
  if (!body) return { ok: false, error: 'Message is empty.' };

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
  });
  if (!conv) return { ok: false, error: 'Conversation not found.' };

  const connection = await getConnectionForInbox(conv.inboxId);
  if (!input.isPrivateNote && !connection) {
    return { ok: false, error: 'This inbox has no connected channel.' };
  }

  // Respect STOP opt-outs at the door (the worker enforces this too).
  if (!input.isPrivateNote && conv.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, conv.contactId),
      columns: { optedOutAt: true },
    });
    if (contact?.optedOutAt) {
      return {
        ok: false,
        error: 'This contact opted out (replied STOP). You can only message them again if they reply START.',
      };
    }
  }

  // A scheduled send is a deliberate future delivery; it bypasses the short
  // undo window (the whole message is undoable until it fires anyway).
  const scheduledAt =
    !input.isPrivateNote && input.scheduledFor ? new Date(input.scheduledFor) : null;

  // Signature happens at send time, not in the composer: it belongs to the
  // send, and appending it here means every path (send now, send later,
  // approve a shared draft) signs consistently.
  if (!input.isPrivateNote) {
    body = appendSignature(body, await resolveSignature(user.id, conv.inboxId));
  }

  // Attribution for shared drafts: "drafted by X, sent by Y".
  let draftedBy: { userId: string; name: string | null } | null = null;
  if (input.draftedByUserId && input.draftedByUserId !== user.id) {
    const author = await db.query.users.findFirst({
      where: eq(users.id, input.draftedByUserId),
      columns: { id: true, name: true },
    });
    if (author) draftedBy = { userId: author.id, name: author.name };
  }

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'outbound',
      authorType: 'agent',
      authorUserId: user.id,
      body,
      isPrivateNote: Boolean(input.isPrivateNote),
      status: input.isPrivateNote ? 'sent' : 'queued',
      tempGuid: input.isPrivateNote ? null : newTempGuid(),
      replyToMessageGuid: input.replyToMessageGuid ?? null,
      sentAt: input.isPrivateNote ? new Date() : null,
      scheduledFor: scheduledAt,
      ...(draftedBy ? { metadata: { draftedBy } } : {}),
    })
    .returning();

  if (!msg) return { ok: false, error: 'Failed to create message.' };

  // Replying resolves a pending nudge — the promise was (presumably) kept.
  const convMeta = (conv.metadata ?? {}) as Record<string, unknown>;
  const clearNudge = !input.isPrivateNote && convMeta.nudge;
  if (clearNudge) delete convMeta.nudge;

  await db
    .update(conversations)
    .set({
      lastMessageAt: new Date(),
      lastMessagePreview: input.isPrivateNote ? `📝 ${body.slice(0, 200)}` : body.slice(0, 280),
      unreadCount: 0,
      firstResponseAt: conv.firstResponseAt ?? (input.isPrivateNote ? null : new Date()),
      // A real reply (not an internal note) satisfies the SLA response clock.
      ...(input.isPrivateNote ? {} : { nextResponseDueAt: null, slaBreachedAt: null }),
      ...(clearNudge ? { metadata: convMeta } : {}),
    })
    .where(eq(conversations.id, conv.id));

  // Undo-send: real replies sit in a delayed job for the undo window; undoSend
  // removes the job by id before the worker ever sees it. Notes skip this.
  // The window is admin-tunable at runtime (Settings → Admin panel → Config).
  const overrides = input.isPrivateNote ? {} : await getRuntimeOverrides();
  const undoMs = input.isPrivateNote
    ? 0
    : (overrides.undoSendSeconds ?? loadConfig().UNDO_SEND_SECONDS) * 1000;
  const delayMs = scheduledAt ? Math.max(scheduledAt.getTime() - Date.now(), 0) : undoMs;

  if (!input.isPrivateNote && connection) {
    await enqueueOutbound(
      {
        messageId: msg.id,
        conversationId: conv.id,
        connectionId: connection.id,
      },
      { jobId: msg.id, delay: delayMs },
    );
  }

  if (input.isPrivateNote) {
    await notifyMentions(conv.id, body, user.id, user.name ?? 'A teammate');
  }

  await publishEvent({
    type: 'message.created',
    conversationId: conv.id,
    inboxId: conv.inboxId,
    messageId: msg.id,
  });
  revalidatePath(`/inbox/${conv.id}`);
  // A scheduled message shows a "cancel" affordance instead of an undo toast.
  return { ok: true, messageId: msg.id, undoMs: scheduledAt ? 0 : undoMs };
}

/** Cancel a scheduled reply before it fires. Same mechanism as undo-send. */
export async function cancelScheduled(messageId: string): Promise<ActionResult> {
  return undoSend(messageId);
}

/**
 * Retract a reply that is still inside its undo window. Removes the delayed
 * BullMQ job (by jobId = messageId) and deletes the message row. Fails cleanly
 * if the worker already picked the job up.
 */
export async function undoSend(messageId: string): Promise<ActionResult> {
  const user = await requireWriter();

  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!msg) return { ok: false, error: 'Message not found.' };
  if (msg.authorUserId !== user.id) return { ok: false, error: 'Only the sender can undo.' };
  if (msg.status !== 'queued') return { ok: false, error: 'Too late — already sent.' };

  const removed = await outboundQueue()
    .remove(messageId)
    .catch(() => 0);
  if (!removed) {
    // The worker grabbed it between our check and the remove.
    return { ok: false, error: 'Too late — already sending.' };
  }

  await db.delete(messages).where(eq(messages.id, messageId));

  // Roll the conversation preview back to the latest remaining message.
  const latest = await db.query.messages.findFirst({
    where: eq(messages.conversationId, msg.conversationId),
    orderBy: [desc(messages.createdAt)],
  });
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, msg.conversationId),
    columns: { id: true, inboxId: true },
  });
  await db
    .update(conversations)
    .set({
      lastMessageAt: latest?.sentAt ?? latest?.createdAt ?? null,
      lastMessagePreview: latest?.body?.slice(0, 280) ?? '',
    })
    .where(eq(conversations.id, msg.conversationId));

  if (conv) {
    await publishEvent({
      type: 'conversation.updated',
      conversationId: conv.id,
      inboxId: conv.inboxId,
    });
  }
  revalidatePath(`/inbox/${msg.conversationId}`);
  return { ok: true };
}

async function systemEvent(conversationId: string, inboxId: string, text: string, actorId: string) {
  await db.insert(messages).values({
    conversationId,
    direction: 'outbound',
    authorType: 'system',
    authorUserId: actorId,
    body: text,
    status: 'sent',
    sentAt: new Date(),
  });
  await publishEvent({ type: 'conversation.updated', conversationId, inboxId });
}

/** Update ticket attributes (status, priority, assignee) and log a timeline event. */
export async function updateConversation(input: {
  id: string;
  status?: 'open' | 'pending' | 'snoozed' | 'closed';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assigneeId?: string | null;
  snoozedUntil?: string | null;
}): Promise<ActionResult> {
  const user = await requireWriter();
  const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, input.id) });
  if (!conv) return { ok: false, error: 'Conversation not found.' };

  const patch: Partial<typeof conversations.$inferInsert> = {};
  const events: string[] = [];

  if (input.status && input.status !== conv.status) {
    patch.status = input.status;
    if (input.status === 'closed') patch.closedAt = new Date();
    // Pause the SLA response clock while not actively open (pending/snoozed/closed).
    if (input.status !== 'open') patch.nextResponseDueAt = null;
    events.push(`marked the ticket as ${input.status}`);
  }
  if (input.priority && input.priority !== conv.priority) {
    patch.priority = input.priority;
    events.push(`set priority to ${input.priority}`);
  }
  if (input.assigneeId !== undefined && input.assigneeId !== conv.assigneeId) {
    patch.assigneeId = input.assigneeId;
    events.push(input.assigneeId ? `assigned the ticket` : `unassigned the ticket`);
  }
  if (input.snoozedUntil !== undefined) {
    patch.snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(conversations).set(patch).where(eq(conversations.id, conv.id));
  for (const e of events) await systemEvent(conv.id, conv.inboxId, `${user.name ?? 'Agent'} ${e}`, user.id);

  // On close, optionally send a CSAT survey over the channel and await the rating.
  if (input.status === 'closed' && conv.status !== 'closed') {
    const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, conv.inboxId) });
    const connection = await getConnectionForInbox(conv.inboxId);
    if (inbox?.settings?.csatEnabled && connection) {
      const body =
        inbox.settings.csatMessage ||
        'Thanks for reaching out! How would you rate your support experience? Reply with a number from 1 (poor) to 5 (great).';
      const [m] = await db
        .insert(messages)
        .values({
          conversationId: conv.id,
          direction: 'outbound',
          authorType: 'agent',
          authorUserId: user.id,
          body,
          status: 'queued',
          tempGuid: newTempGuid(),
        })
        .returning();
      if (m) {
        await enqueueOutbound({
          messageId: m.id,
          conversationId: conv.id,
          connectionId: connection.id,
        });
      }
      await db
        .update(conversations)
        .set({
          metadata: { ...(conv.metadata ?? {}), csat: { awaiting: true, at: new Date().toISOString() } },
        })
        .where(eq(conversations.id, conv.id));
    }
  }

  // Closing it IS dealing with it, so the pin has done its job — for whoever
  // asked for that. See `unpinClosedFor`.
  if (input.status === 'closed' && conv.status !== 'closed') await unpinClosedFor([conv.id]);

  await publishEvent({ type: 'conversation.updated', conversationId: conv.id, inboxId: conv.inboxId });
  revalidatePath('/inbox');
  revalidatePath(`/inbox/${conv.id}`);
  return { ok: true };
}

export async function toggleTag(conversationId: string, tagId: string): Promise<ActionResult> {
  await requireWriter();
  const existing = await db.query.conversationTags.findFirst({
    where: and(
      eq(conversationTags.conversationId, conversationId),
      eq(conversationTags.tagId, tagId),
    ),
  });
  if (existing) {
    await db
      .delete(conversationTags)
      .where(
        and(
          eq(conversationTags.conversationId, conversationId),
          eq(conversationTags.tagId, tagId),
        ),
      );
  } else {
    await db.insert(conversationTags).values({ conversationId, tagId }).onConflictDoNothing();
  }
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}

/** Apply a status/assignee change to many conversations at once. */
export async function bulkUpdateConversations(
  ids: string[],
  patch: { status?: 'open' | 'pending' | 'closed'; assigneeId?: string | null },
): Promise<ActionResult> {
  await requireWriter();
  if (ids.length === 0) return { ok: true };

  const set: Partial<typeof conversations.$inferInsert> = {};
  if (patch.status) {
    set.status = patch.status;
    if (patch.status === 'closed') set.closedAt = new Date();
    if (patch.status !== 'open') set.nextResponseDueAt = null;
  }
  if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
  if (Object.keys(set).length === 0) return { ok: true };

  await db.update(conversations).set(set).where(inArray(conversations.id, ids));
  if (patch.status === 'closed') await unpinClosedFor(ids);
  revalidatePath('/inbox');
  return { ok: true };
}

/**
 * Arm a follow-up reminder: "bump this back to me at T if the customer hasn't
 * replied." Passing null cancels it. Distinct from snooze — see the worker's
 * followUps sweep.
 */
export async function setFollowUp(
  conversationId: string,
  at: string | null,
): Promise<ActionResult> {
  const user = await requireWriter();
  await db
    .update(conversations)
    .set({
      followUpAt: at ? new Date(at) : null,
      followUpArmedAt: at ? new Date() : null,
      followUpUserId: at ? user.id : null,
    })
    .where(eq(conversations.id, conversationId));
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}

/** Mark a conversation read (clears the unread badge in Comms). */
export async function markRead(conversationId: string): Promise<ActionResult> {
  await requireWriter();
  await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(eq(conversations.id, conversationId));
  return { ok: true };
}

/**
 * Mute or unmute a conversation. A muted thread stays exactly where it is and
 * keeps receiving messages — it just stops counting as unread and stops
 * making noise. Permanent until unmuted, which is the difference from snooze.
 */
export async function setMuted(conversationId: string, muted: boolean): Promise<ActionResult> {
  await requireWriter();
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, inboxId: true },
  });
  if (!conv) return { ok: false, error: 'Conversation not found.' };

  await db
    .update(conversations)
    .set({
      mutedAt: muted ? new Date() : null,
      // Muting also silences what already piled up — that pile is why you
      // reached for the button.
      ...(muted ? { unreadCount: 0 } : {}),
    })
    .where(eq(conversations.id, conversationId));

  await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
  revalidatePath('/inbox');
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}

/**
 * Dismiss a nudge ("you said you'd send this…"). Remembered per promise: the
 * same message never nudges twice, but a NEW promise in a later reply can.
 */
export async function dismissNudge(conversationId: string): Promise<ActionResult> {
  await requireWriter();
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, inboxId: true, metadata: true },
  });
  if (!conv) return { ok: false, error: 'Conversation not found.' };

  const meta = (conv.metadata ?? {}) as Record<string, unknown>;
  const nudge = meta.nudge as Record<string, unknown> | undefined;
  if (!nudge) return { ok: true };

  await db
    .update(conversations)
    .set({ metadata: { ...meta, nudge: { ...nudge, dismissedAt: new Date().toISOString() } } })
    .where(eq(conversations.id, conversationId));

  await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
  revalidatePath(`/inbox/${conversationId}`);
  return { ok: true };
}
