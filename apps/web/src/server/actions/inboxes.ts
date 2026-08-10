'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, sql } from '@comms/db';
import { inboxes, conversations, messages, channelConnections } from '@comms/db';
import { db } from '@/server/db';
import { requirePermission, requirePermissionForRead } from '@/lib/session';

export type InboxResult = { ok: true; message?: string } | { ok: false; error: string };

export interface InboxSummary {
  id: string;
  name: string;
  conversationCount: number;
  messageCount: number;
  hasConnection: boolean;
}

/** Counts used to warn before anything destructive. */
export async function getInboxSummary(inboxId: string): Promise<InboxSummary | null> {
  await requirePermissionForRead('inboxes.manage');
  const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, inboxId) });
  if (!inbox) return null;

  const [convRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(conversations)
    .where(eq(conversations.inboxId, inboxId));

  const [msgRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(conversations.inboxId, inboxId));

  const [connRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(channelConnections)
    .where(eq(channelConnections.inboxId, inboxId));

  return {
    id: inbox.id,
    name: inbox.name,
    conversationCount: Number(convRow?.n ?? 0),
    messageCount: Number(msgRow?.n ?? 0),
    hasConnection: Number(connRow?.n ?? 0) > 0,
  };
}

/**
 * Delete an inbox and everything in it.
 *
 * Deleting cascades to conversations and messages, so this refuses by default
 * when there's history and reports what would be lost. `confirmDeleteMessages`
 * is the caller saying "yes, I've seen the number".
 */
export async function deleteInbox(
  inboxId: string,
  options: { confirmDeleteMessages?: boolean } = {},
): Promise<InboxResult> {
  await requirePermission('inboxes.manage');

  const summary = await getInboxSummary(inboxId);
  if (!summary) return { ok: false, error: 'Inbox not found.' };

  if (summary.conversationCount > 0 && !options.confirmDeleteMessages) {
    return {
      ok: false,
      error: `That inbox still holds ${summary.conversationCount} conversation${
        summary.conversationCount === 1 ? '' : 's'
      } and ${summary.messageCount} message${
        summary.messageCount === 1 ? '' : 's'
      }. Move them to your other inbox first, or confirm you want them deleted.`,
    };
  }

  // Remove the webhook from the Mac before dropping the row, so we don't leave
  // a dead registration pointing at us.
  const conns = await db.query.channelConnections.findMany({
    where: eq(channelConnections.inboxId, inboxId),
  });
  for (const conn of conns) {
    if (!conn.providerWebhookId) continue;
    try {
      const { BlueBubblesClient, decryptSecret, loadConfig } = await import('@comms/core');
      const client = new BlueBubblesClient({
        serverUrl: conn.serverUrl,
        password: decryptSecret(conn.credentialsEncrypted, loadConfig().appSecret),
      });
      await client.deleteWebhook(conn.providerWebhookId).catch(() => {});
    } catch {
      /* the old server may be unreachable — that's exactly why it's being deleted */
    }
  }

  await db.delete(inboxes).where(eq(inboxes.id, inboxId));

  revalidatePath('/settings/inboxes');
  revalidatePath('/inbox');
  return {
    ok: true,
    message:
      summary.conversationCount > 0
        ? `Deleted "${summary.name}" and ${summary.conversationCount} conversation(s).`
        : `Deleted "${summary.name}".`,
  };
}

/**
 * Move every conversation from one inbox into another, then delete the empty
 * source. This is the non-destructive way out of a duplicate-inbox situation.
 *
 * Conversations are unique on (inboxId, providerChatGuid), so when both
 * inboxes hold the same chat the messages are merged into the target's
 * conversation rather than colliding.
 */
export async function mergeInboxes(input: {
  sourceInboxId: string;
  targetInboxId: string;
}): Promise<InboxResult> {
  await requirePermission('inboxes.manage');
  if (input.sourceInboxId === input.targetInboxId) {
    return { ok: false, error: 'Pick two different inboxes.' };
  }

  const source = await db.query.inboxes.findFirst({ where: eq(inboxes.id, input.sourceInboxId) });
  const target = await db.query.inboxes.findFirst({ where: eq(inboxes.id, input.targetInboxId) });
  if (!source || !target) return { ok: false, error: 'Inbox not found.' };

  const sourceConvs = await db.query.conversations.findMany({
    where: eq(conversations.inboxId, input.sourceInboxId),
  });

  let moved = 0;
  let mergedInto = 0;

  for (const conv of sourceConvs) {
    const clash = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.inboxId, input.targetInboxId),
        eq(conversations.providerChatGuid, conv.providerChatGuid),
      ),
    });

    if (clash) {
      // Same chat exists on both sides — move the messages across and drop the
      // now-empty duplicate conversation.
      await db
        .update(messages)
        .set({ conversationId: clash.id })
        .where(eq(messages.conversationId, conv.id));
      await db.delete(conversations).where(eq(conversations.id, conv.id));
      mergedInto += 1;
    } else {
      await db
        .update(conversations)
        .set({ inboxId: input.targetInboxId })
        .where(eq(conversations.id, conv.id));
      moved += 1;
    }
  }

  // The source is empty now, so this deletes nothing but the inbox itself.
  await deleteInbox(input.sourceInboxId, { confirmDeleteMessages: true });

  revalidatePath('/settings/inboxes');
  revalidatePath('/inbox');
  return {
    ok: true,
    message:
      mergedInto > 0
        ? `Moved ${moved} conversation(s) and merged ${mergedInto} duplicate(s) into "${target.name}".`
        : `Moved ${moved} conversation(s) into "${target.name}".`,
  };
}

/** Rename an inbox — handy once you have more than one number. */
export async function renameInbox(inboxId: string, name: string): Promise<InboxResult> {
  await requirePermission('inboxes.manage');
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'Name is required.' };
  await db.update(inboxes).set({ name: trimmed }).where(eq(inboxes.id, inboxId));
  revalidatePath('/settings/inboxes');
  revalidatePath('/inbox');
  return { ok: true };
}
