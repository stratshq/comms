'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, ilike, or, sql } from '@comms/db';
import { conversations, messages, contacts, contactIdentities, inboxes } from '@comms/db';
import {
  BlueBubblesClient,
  decryptSecret,
  loadConfig,
  normalizeAddress,
  addressMatchKey,
  newTempGuid,
  describeConnectionError,
  publishEvent,
  logger,
} from '@comms/core';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';
import { formatAddress } from '@/lib/naming';
import { getConnectionForInbox } from '@/server/queries';

const log = logger.child({ action: 'new-conversation' });

export type StartResult =
  | { ok: true; conversationId: string; existing: boolean }
  | { ok: false; error: string };

export interface RecipientSuggestion {
  contactId: string | null;
  name: string;
  address: string;
  /** True when we already have a conversation with them. */
  hasConversation: boolean;
  conversationId: string | null;
}

/**
 * Type-ahead over known contacts and their addresses. Falls back to treating
 * the raw input as an address so you can always message someone new.
 */
export async function searchRecipients(term: string): Promise<RecipientSuggestion[]> {
  await requireUser();
  const q = term.trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;

  const rows = await db
    .select({
      contactId: contacts.id,
      name: contacts.displayName,
      address: contactIdentities.value,
      rawValue: contactIdentities.rawValue,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      or(
        ilike(contacts.displayName, like),
        ilike(contactIdentities.value, like),
        ilike(contactIdentities.rawValue, like),
      ),
    )
    .limit(20);

  const suggestions: RecipientSuggestion[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    if (seen.has(r.address)) continue;
    seen.add(r.address);

    const existing = await db.query.conversations.findFirst({
      where: eq(conversations.contactId, r.contactId),
      columns: { id: true },
    });

    const address = r.rawValue || r.address;
    suggestions.push({
      contactId: r.contactId,
      // `||` so an unnamed contact falls through to its number rather than
      // showing a blank row, and the number is formatted the way the inbox
      // formats it.
      name: r.name || formatAddress(address) || address,
      address,
      hasConversation: Boolean(existing),
      conversationId: existing?.id ?? null,
    });
  }

  // Always allow messaging a raw address that isn't in the address book.
  const looksLikeAddress = /^[+\d()\-.\s]{7,}$/.test(q) || q.includes('@');
  if (looksLikeAddress && !suggestions.some((s) => s.address.replace(/\D/g, '') === q.replace(/\D/g, ''))) {
    suggestions.unshift({
      contactId: null,
      name: q,
      address: q,
      hasConversation: false,
      conversationId: null,
    });
  }

  return suggestions.slice(0, 8);
}

/**
 * Start a conversation with an address, sending the first message.
 *
 * If we already have a conversation with that person we hand back the existing
 * one rather than creating a duplicate — sending to someone you've already
 * spoken to should land in the same thread.
 */
export async function startConversation(input: {
  address: string;
  message: string;
  inboxId?: string;
}): Promise<StartResult> {
  const user = await requireWriter();

  const address = input.address.trim();
  const body = input.message.trim();
  if (!address) return { ok: false, error: 'Who do you want to message?' };
  if (!body) return { ok: false, error: 'Write a message first.' };

  const inbox = input.inboxId
    ? await db.query.inboxes.findFirst({ where: eq(inboxes.id, input.inboxId) })
    : await db.query.inboxes.findFirst({ orderBy: (i, { desc }) => [desc(i.isDefault)] });
  if (!inbox) return { ok: false, error: 'No inbox is set up yet.' };

  const connection = await getConnectionForInbox(inbox.id);
  if (!connection) return { ok: false, error: 'This inbox has no connected channel.' };

  // Already talking to them? Reuse the thread.
  const norm = normalizeAddress(address);
  const key = addressMatchKey(norm);
  const identities = await db
    .select({ contactId: contactIdentities.contactId, value: contactIdentities.value, kind: contactIdentities.kind })
    .from(contactIdentities);
  const match = identities.find(
    (i) => addressMatchKey({ kind: i.kind, value: i.value, raw: i.value }) === key,
  );

  if (match) {
    const existing = await db.query.conversations.findFirst({
      where: and(eq(conversations.contactId, match.contactId), eq(conversations.inboxId, inbox.id)),
    });
    if (existing) return { ok: true, conversationId: existing.id, existing: true };
  }

  // Ask BlueBubbles to open the chat and send the first message.
  const client = new BlueBubblesClient({
    serverUrl: connection.serverUrl,
    password: decryptSecret(connection.credentialsEncrypted, loadConfig().appSecret),
  });
  const tempGuid = newTempGuid();

  let chatGuid: string;
  try {
    const chat = await client.createChat({
      addresses: [norm.value],
      message: body,
      method: connection.capabilities?.privateApi ? 'private-api' : 'apple-script',
      tempGuid,
    });
    chatGuid = chat?.guid;
    if (!chatGuid) throw new Error('BlueBubbles did not return a chat id');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'createChat failed');
    return { ok: false, error: describeConnectionError(err, connection.serverUrl) };
  }

  // Persist locally. The webhook echo will reconcile the message by tempGuid.
  let contactId = match?.contactId ?? null;
  if (!contactId) {
    const [created] = await db
      .insert(contacts)
      .values({ displayName: norm.raw })
      .returning({ id: contacts.id });
    contactId = created?.id ?? null;
    if (contactId) {
      await db
        .insert(contactIdentities)
        .values({ contactId, kind: norm.kind, value: norm.value, rawValue: norm.raw })
        .onConflictDoNothing();
    }
  }

  const [conv] = await db
    .insert(conversations)
    .values({
      inboxId: inbox.id,
      providerChatGuid: chatGuid,
      contactId,
      isGroup: false,
      status: 'open',
      assigneeId: user.id,
      lastMessageAt: new Date(),
      lastMessagePreview: body.slice(0, 280),
    })
    .onConflictDoNothing()
    .returning();

  const conversation =
    conv ??
    (await db.query.conversations.findFirst({
      where: and(
        eq(conversations.inboxId, inbox.id),
        eq(conversations.providerChatGuid, chatGuid),
      ),
    }));
  if (!conversation) return { ok: false, error: 'Could not save the conversation.' };

  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    authorType: 'agent',
    authorUserId: user.id,
    body,
    status: 'sent',
    sentAt: new Date(),
    tempGuid,
  });

  await publishEvent({
    type: 'conversation.created',
    conversationId: conversation.id,
    inboxId: inbox.id,
  });
  revalidatePath('/inbox');
  return { ok: true, conversationId: conversation.id, existing: false };
}
