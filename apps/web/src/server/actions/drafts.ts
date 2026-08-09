'use server';

import { and, eq, desc, isNotNull, sql } from '@comms/db';
import { drafts, conversations, users } from '@comms/db';
import { publishEvent } from '@comms/core';
import { db } from '@/server/db';
import { can, requireDbUser, requireUser } from '@/lib/session';
import { sendMessage, type SendResult } from './inbox';

/**
 * Unsent replies, kept server-side rather than in localStorage.
 *
 * localStorage would be simpler but wrong for this product: a draft is worth
 * keeping precisely because you walked away, and walking away often means a
 * different device. It also has to be readable by the conversation list to put
 * a marker on the row, which a browser-local store cannot do.
 */

export type SaveDraftInput = {
  conversationId: string;
  body: string;
  isPrivateNote?: boolean;
  replyToMessageId?: string | null;
};

/**
 * Upsert the caller's draft for a conversation.
 *
 * An empty body deletes the row instead of storing '' — otherwise every
 * conversation you ever opened and typed a character into would keep a draft
 * marker forever.
 */
export async function saveDraft(input: SaveDraftInput): Promise<{ ok: boolean }> {
  const me = await requireUser();
  const body = input.body ?? '';

  if (!body.trim()) {
    await db
      .delete(drafts)
      .where(and(eq(drafts.conversationId, input.conversationId), eq(drafts.userId, me.id)));
    return { ok: true };
  }

  await db
    .insert(drafts)
    .values({
      conversationId: input.conversationId,
      userId: me.id,
      body,
      isPrivateNote: input.isPrivateNote ?? false,
      replyToMessageId: input.replyToMessageId ?? null,
    })
    .onConflictDoUpdate({
      target: [drafts.conversationId, drafts.userId],
      set: {
        body,
        isPrivateNote: input.isPrivateNote ?? false,
        replyToMessageId: input.replyToMessageId ?? null,
        updatedAt: new Date(),
      },
    });

  return { ok: true };
}

/** Drop the draft once its message is actually sent. */
export async function clearDraft(conversationId: string): Promise<{ ok: boolean }> {
  const me = await requireUser();
  await db
    .delete(drafts)
    .where(and(eq(drafts.conversationId, conversationId), eq(drafts.userId, me.id)));
  return { ok: true };
}

export type PendingDraft = {
  conversationId: string;
  body: string;
  isPrivateNote: boolean;
  updatedAt: Date;
  conversationTitle: string | null;
};

/** Every draft the caller has going, newest first — powers the Drafts folder. */
export async function listMyDrafts(): Promise<PendingDraft[]> {
  const me = await requireUser();
  const rows = await db
    .select({
      conversationId: drafts.conversationId,
      body: drafts.body,
      isPrivateNote: drafts.isPrivateNote,
      updatedAt: drafts.updatedAt,
      conversationTitle: conversations.title,
    })
    .from(drafts)
    .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
    .where(eq(drafts.userId, me.id))
    .orderBy(desc(drafts.updatedAt))
    .limit(200);
  return rows;
}

/** Conversation ids the caller has a draft in — the list marks these rows. */
export async function myDraftConversationIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ conversationId: drafts.conversationId })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), sql`length(btrim(${drafts.body})) > 0`));
  return rows.map((r) => r.conversationId);
}

/** The caller's draft for one conversation, for restoring the composer. */
export async function getMyDraft(
  conversationId: string,
): Promise<{ body: string; isPrivateNote: boolean; shared: boolean } | null> {
  const me = await requireUser();
  const [row] = await db
    .select({ body: drafts.body, isPrivateNote: drafts.isPrivateNote, sharedAt: drafts.sharedAt })
    .from(drafts)
    .where(and(eq(drafts.conversationId, conversationId), eq(drafts.userId, me.id)))
    .limit(1);
  if (!row) return null;
  return { body: row.body, isPrivateNote: row.isPrivateNote, shared: Boolean(row.sharedAt) };
}

// ---- Shared drafts ----------------------------------------------------------
//
// The Front/Missive flow: one person writes the reply, someone else approves
// and sends it. A shared draft is just a draft with `sharedAt` set — the text
// stays owned by its author (they keep editing it from their own composer),
// and any teammate can send it, load it into their composer to rework it, or
// hand it back.

export interface SharedDraft {
  conversationId: string;
  authorUserId: string;
  authorName: string | null;
  body: string;
  sharedAt: Date;
  updatedAt: Date;
  /** True when this is the caller's own shared draft. */
  mine: boolean;
}

/** Share the caller's current draft with the team for review. */
export async function shareMyDraft(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const me = await requireUser();
  const [row] = await db
    .update(drafts)
    .set({ sharedAt: new Date() })
    .where(
      and(
        eq(drafts.conversationId, conversationId),
        eq(drafts.userId, me.id),
        // Only replies can be shared — an internal note is already visible
        // to the team the moment it's posted.
        eq(drafts.isPrivateNote, false),
        sql`length(btrim(${drafts.body})) > 0`,
      ),
    )
    .returning({ conversationId: drafts.conversationId });
  if (!row) return { ok: false, error: 'Write the draft first, then share it.' };

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { inboxId: true },
  });
  if (conv) {
    await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
  }
  return { ok: true };
}

/**
 * Take a shared draft back to private. The author can always do this; an
 * admin can too (their "discard" of someone's proposal returns it rather than
 * destroying their words).
 */
export async function unshareDraft(
  conversationId: string,
  authorUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const me = await requireDbUser();
  if (me.id !== authorUserId && !can(me, 'workspace.manage')) {
    return { ok: false, error: 'Only the author or an admin can put a shared draft back.' };
  }
  await db
    .update(drafts)
    .set({ sharedAt: null })
    .where(and(eq(drafts.conversationId, conversationId), eq(drafts.userId, authorUserId)));

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { inboxId: true },
  });
  if (conv) {
    await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
  }
  return { ok: true };
}

/**
 * Approve a teammate's shared draft and send it. The message goes out under
 * the approver's name with "drafted by" attribution in its metadata, and the
 * draft is consumed. Sending runs through `sendMessage`, so the undo window,
 * signatures, STOP guards and optimistic UI all apply unchanged.
 */
export async function sendSharedDraft(
  conversationId: string,
  authorUserId: string,
): Promise<SendResult> {
  await requireUser();
  const [draft] = await db
    .select({ body: drafts.body, sharedAt: drafts.sharedAt })
    .from(drafts)
    .where(and(eq(drafts.conversationId, conversationId), eq(drafts.userId, authorUserId)))
    .limit(1);
  if (!draft?.sharedAt || !draft.body.trim()) {
    return { ok: false, error: 'That draft is no longer shared.' };
  }

  const res = await sendMessage({
    conversationId,
    body: draft.body,
    draftedByUserId: authorUserId,
  });
  if (res.ok) {
    await db
      .delete(drafts)
      .where(and(eq(drafts.conversationId, conversationId), eq(drafts.userId, authorUserId)));
  }
  return res;
}

/**
 * Put a consumed shared draft back after an undone send. Only writes when the
 * author has no draft on the conversation (they may have started a new one in
 * the meantime — never overwrite that).
 */
export async function restoreSharedDraft(
  conversationId: string,
  authorUserId: string,
  body: string,
): Promise<{ ok: boolean }> {
  await requireUser();
  if (!body.trim()) return { ok: true };
  await db
    .insert(drafts)
    .values({
      conversationId,
      userId: authorUserId,
      body,
      isPrivateNote: false,
      sharedAt: new Date(),
    })
    .onConflictDoNothing();
  return { ok: true };
}

/** Every shared draft on a conversation, the caller's own included. */
export async function listSharedDrafts(conversationId: string): Promise<SharedDraft[]> {
  const me = await requireUser();
  const rows = await db
    .select({
      conversationId: drafts.conversationId,
      authorUserId: drafts.userId,
      authorName: users.name,
      body: drafts.body,
      sharedAt: drafts.sharedAt,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .innerJoin(users, eq(users.id, drafts.userId))
    .where(
      and(
        eq(drafts.conversationId, conversationId),
        isNotNull(drafts.sharedAt),
        eq(drafts.isPrivateNote, false),
        sql`length(btrim(${drafts.body})) > 0`,
      ),
    )
    .orderBy(desc(drafts.sharedAt));
  return rows.map((r) => ({ ...r, sharedAt: r.sharedAt!, mine: r.authorUserId === me.id }));
}
