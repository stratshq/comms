'use server';

import { revalidatePath } from 'next/cache';
import { eq } from '@comms/db';
import { conversations, messages } from '@comms/db';
import {
  BlueBubblesClient,
  decryptSecret,
  loadConfig,
  publishEvent,
  type BBReaction,
  logger,
} from '@comms/core';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';
import { getConnectionForInbox } from '@/server/queries';

const log = logger.child({ action: 'imessage' });

export type ImessageResult = { ok: true } | { ok: false; error: string };

type ClientContext =
  | { error: string }
  | {
      conv: typeof conversations.$inferSelect;
      connection: NonNullable<Awaited<ReturnType<typeof getConnectionForInbox>>>;
      client: BlueBubblesClient;
    };

/** Reactions, typing and read receipts all need the Private API on the Mac. */
async function clientFor(conversationId: string): Promise<ClientContext> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) return { error: 'Conversation not found.' };

  const connection = await getConnectionForInbox(conv.inboxId);
  if (!connection) return { error: 'This inbox has no connected channel.' };

  const client = new BlueBubblesClient({
    serverUrl: connection.serverUrl,
    password: decryptSecret(connection.credentialsEncrypted, loadConfig().appSecret),
  });
  return { conv, connection, client };
}

/**
 * Send a tapback. The client method has existed since day one with zero
 * callers — Comms could receive 👍 but never send one.
 */
export async function sendReaction(input: {
  conversationId: string;
  messageId: string;
  reaction: BBReaction;
}): Promise<ImessageResult> {
  await requireWriter();
  const ctx = await clientFor(input.conversationId);
  if ('error' in ctx) return { ok: false, error: ctx.error };

  if (!ctx.connection.capabilities?.privateApi) {
    return {
      ok: false,
      error: 'Reactions need the BlueBubbles Private API, which is not enabled on your Mac.',
    };
  }

  const target = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
  if (!target?.providerMessageGuid) {
    return { ok: false, error: 'That message can’t be reacted to yet — it hasn’t sent.' };
  }

  try {
    await ctx.client.react({
      chatGuid: ctx.conv.providerChatGuid,
      selectedMessageGuid: target.providerMessageGuid,
      reaction: input.reaction,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'reaction failed');
    return { ok: false, error: `Could not send the reaction: ${(err as Error).message}` };
  }

  // Record it locally so the timeline updates without waiting for the echo.
  await db.insert(messages).values({
    conversationId: ctx.conv.id,
    direction: 'outbound',
    authorType: 'agent',
    associatedMessageGuid: target.providerMessageGuid,
    reactionType: input.reaction,
    status: 'sent',
    sentAt: new Date(),
  });

  await publishEvent({
    type: 'conversation.updated',
    conversationId: ctx.conv.id,
    inboxId: ctx.conv.inboxId,
  });
  revalidatePath(`/inbox/${ctx.conv.id}`);
  return { ok: true };
}

/**
 * Show the customer a typing bubble while an agent composes. Fire-and-forget:
 * a failure here must never surface to the agent mid-typing.
 */
export async function sendTypingIndicator(input: {
  conversationId: string;
  isTyping: boolean;
}): Promise<ImessageResult> {
  await requireWriter();
  const ctx = await clientFor(input.conversationId);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  if (!ctx.connection.capabilities?.privateApi) return { ok: true }; // silently unsupported

  const inbox = await db.query.inboxes.findFirst({
    where: (i, { eq: e }) => e(i.id, ctx.conv.inboxId),
  });
  if (!inbox?.settings?.sendTypingIndicators) return { ok: true }; // disabled for this inbox

  try {
    if (input.isTyping) await ctx.client.startTyping(ctx.conv.providerChatGuid);
    else await ctx.client.stopTyping(ctx.conv.providerChatGuid);
  } catch {
    // Non-critical.
  }
  return { ok: true };
}

/** Mark the thread read on the Mac, so the customer sees a read receipt. */
export async function sendReadReceipt(conversationId: string): Promise<ImessageResult> {
  await requireWriter();
  const ctx = await clientFor(conversationId);
  if ('error' in ctx) return { ok: false, error: ctx.error };
  try {
    await ctx.client.markRead(ctx.conv.providerChatGuid);
  } catch {
    // Non-critical.
  }
  return { ok: true };
}
