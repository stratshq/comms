import { getDb, eq, and, desc, isNull, isNotNull, ne } from '@comms/db';
import {
  conversations,
  messages,
  attachments,
  contacts,
  channelConnections,
} from '@comms/db';
import {
  type BBMessage,
  bbDate,
  parseChatGuid,
  addressFromChatGuid,
  reactionFromAssociatedType,
  parseTextTapback,
  isVoiceMemoAttachment,
  classifyCorrespondent,
  isRealContactName,
  enqueueAttachment,
  enqueueAi,
  publishEvent,
  logger,
} from '@comms/core';
import { isAiConfigured } from '@comms/ai';
import {
  linkParticipants,
  resolveContact,
  resolveConversationContact,
} from './participants.js';
import { maybeAutoAssign } from './assign.js';
import { onInboundSlaCsat } from './sla.js';
import { runAutomations } from './automations.js';

const log = logger.child({ module: 'ingest' });

/** Standard carrier opt-out / opt-in keywords (TCPA / CTIA). Exact match only. */
const OPT_OUT_RE = /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|revoke)\s*$/i;
const OPT_IN_RE = /^\s*(start|unstop|resume)\s*$/i;

/**
 * Honor STOP/START keywords from the contact. Sets/clears contacts.optedOutAt
 * (the outbound processor refuses to send while it is set) and drops a system
 * event into the timeline so agents can see why sending is blocked.
 */
async function handleOptKeywords(
  conversationId: string,
  contactId: string,
  bodyText: string,
): Promise<void> {
  const db = getDb();
  const isOut = OPT_OUT_RE.test(bodyText);
  const isIn = !isOut && OPT_IN_RE.test(bodyText);
  if (!isOut && !isIn) return;

  await db
    .update(contacts)
    .set({ optedOutAt: isOut ? new Date() : null })
    .where(eq(contacts.id, contactId));
  await db.insert(messages).values({
    conversationId,
    direction: 'outbound',
    authorType: 'system',
    body: isOut
      ? 'Contact opted out (STOP) — outbound messages are now blocked'
      : 'Contact opted back in (START) — outbound messages re-enabled',
    status: 'sent',
    sentAt: new Date(),
  });
  log.info({ contactId, optedOut: isOut }, 'opt keyword processed');
}

/** Upsert the conversation for a chat GUID within an inbox. */
async function ensureConversation(
  inboxId: string,
  chatGuid: string,
  contactId: string | null,
  meta: { title?: string | null },
): Promise<{ conversation: typeof conversations.$inferSelect; created: boolean }> {
  const db = getDb();
  const parsed = parseChatGuid(chatGuid);

  const found = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.inboxId, inboxId),
      eq(conversations.providerChatGuid, chatGuid),
    ),
  });
  if (found) return { conversation: found, created: false };

  const inserted = await db
    .insert(conversations)
    .values({
      inboxId,
      providerChatGuid: chatGuid,
      contactId,
      isGroup: parsed.isGroup,
      // A brand-new one-to-one thread is by definition from someone we don't
      // know yet; the classifier refines this as soon as messages land.
      kind: parsed.isGroup ? 'person' : 'unknown',
      // `||` not `??`: BlueBubbles sends an EMPTY STRING for any chat the user
      // never named, and `'' ?? x` keeps the empty string — which rendered as a
      // blank row all the way through the UI.
      title: meta.title?.trim() || (parsed.isGroup ? 'Group conversation' : null),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    await publishEvent({
      type: 'conversation.created',
      conversationId: inserted[0].id,
      inboxId,
    });
    return { conversation: inserted[0], created: true };
  }

  // Lost a race — fetch the row the other worker created.
  const existing = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.inboxId, inboxId),
      eq(conversations.providerChatGuid, chatGuid),
    ),
  });
  if (!existing) throw new Error(`Failed to upsert conversation for ${chatGuid}`);
  return { conversation: existing, created: false };
}

/**
 * Re-classify a conversation's correspondent kind after inbound traffic.
 *
 * Runs on every inbound message rather than once at creation: a number that
 * only ever sent codes is an OTP thread, right up until a human uses it, and
 * the split inbox has to notice the moment that happens. Writes only on an
 * actual change so the common case costs one comparison.
 */
async function reclassifyKind(
  conversationId: string,
  conv: typeof conversations.$inferSelect,
): Promise<void> {
  const db = getDb();

  const [recent, contact, outbound] = await Promise.all([
    db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
      .orderBy(desc(messages.createdAt))
      .limit(5),
    conv.contactId
      ? db.query.contacts.findFirst({
          where: eq(contacts.id, conv.contactId),
          columns: { displayName: true },
        })
      : Promise.resolve(null),
    db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
        eq(messages.isPrivateNote, false),
        // System events are ours but not a reply — "Assigned to X" must not
        // make an OTP thread look like a conversation.
        ne(messages.authorType, 'system'),
      ),
      columns: { id: true },
    }),
  ]);

  const kind = classifyCorrespondent({
    address: addressFromChatGuid(conv.providerChatGuid),
    hasContactName: isRealContactName(contact?.displayName, [
      addressFromChatGuid(conv.providerChatGuid),
    ]),
    inboundBodies: recent.map((r) => r.body),
    hasOutbound: Boolean(outbound),
    isGroup: conv.isGroup,
    inboundCount: recent.length,
  });

  if (kind === conv.kind) return;
  await db.update(conversations).set({ kind }).where(eq(conversations.id, conversationId));
}

/** Insert attachment rows (pending) and enqueue downloads to S3. */
async function ingestAttachments(connectionId: string, messageId: string, bb: BBMessage) {
  if (!bb.attachments?.length) return;
  const db = getDb();
  for (const att of bb.attachments) {
    const [row] = await db
      .insert(attachments)
      .values({
        messageId,
        providerAttachmentGuid: att.guid,
        fileName: att.transferName ?? null,
        mimeType: att.mimeType ?? null,
        // The UTI is the only field the server doesn't rewrite during audio
        // conversion — it's what makes voice-memo detection reliable.
        uti: att.uti ?? null,
        isVoiceMemo: isVoiceMemoAttachment({
          uti: att.uti,
          mimeType: att.mimeType,
          fileName: att.transferName,
          isAudioMessage: bb.isAudioMessage,
        }),
        sizeBytes: att.totalBytes ?? null,
        width: att.width ?? null,
        height: att.height ?? null,
        status: 'pending',
      })
      .returning({ id: attachments.id });
    if (row) {
      await enqueueAttachment({
        attachmentId: row.id,
        connectionId,
        providerAttachmentGuid: att.guid,
      });
    }
  }
}

/**
 * Ingest a `new-message` event. Handles three cases:
 *  1. Inbound customer message → new message row, bump conversation.
 *  2. Our own outbound echo (isFromMe + matching tempGuid) → reconcile the row.
 *  3. A message sent from the Mac/iPhone outside Comms (isFromMe, no tempGuid) → external.
 */
export async function ingestNewMessage(connectionId: string, bb: BBMessage): Promise<void> {
  const db = getDb();

  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
  });
  if (!conn) throw new Error(`connection ${connectionId} not found`);

  const chatGuid = bb.chats?.[0]?.guid;
  if (!chatGuid) {
    // Loud, with enough context to tell a genuinely chat-less event from a
    // payload-shape problem — this used to silently swallow messages.
    log.warn(
      { guid: bb.guid, chatCount: bb.chats?.length ?? 0, isFromMe: bb.isFromMe },
      'message without a resolvable chat guid; skipping',
    );
    return;
  }

  // Dedup: have we already stored this provider message?
  if (bb.guid) {
    const dup = await db.query.messages.findFirst({
      where: eq(messages.providerMessageGuid, bb.guid),
    });
    if (dup) {
      log.debug({ guid: bb.guid }, 'duplicate message; skipping');
      return;
    }
  }

  /**
   * A structured tapback, or the plain-text one SMS delivers instead.
   *
   * The fallback is keyed on whether a reaction actually RESOLVED, not on
   * whether `associatedMessageType` is truthy. BlueBubbles sends `"0"` for an
   * ordinary message in some payload shapes, and the string `"0"` is truthy
   * in JavaScript — so the truthiness test concluded "this is a structured
   * tapback", declined to read the text, and then resolved no reaction from
   * the 0. Every SMS tapback fell straight through as a plain message, which
   * is the bug this whole path exists to fix.
   */
  const structuredReaction = reactionFromAssociatedType(bb.associatedMessageType);
  const textTapback = structuredReaction ? null : parseTextTapback(bb.text);
  const reaction = structuredReaction ?? textTapback?.reaction ?? null;
  const sentAt = bbDate(bb.dateCreated) ?? new Date();

  // Case 2: reconcile our outbound echo by tempGuid.
  if (bb.isFromMe && bb.tempGuid) {
    const pending = await db.query.messages.findFirst({
      where: eq(messages.tempGuid, bb.tempGuid),
    });
    if (pending) {
      await db
        .update(messages)
        .set({
          providerMessageGuid: bb.guid,
          status: 'sent',
          sentAt,
          deliveredAt: bbDate(bb.dateDelivered),
          readAt: bbDate(bb.dateRead),
        })
        .where(eq(messages.id, pending.id));
      await publishEvent({
        type: 'message.updated',
        conversationId: pending.conversationId,
        inboxId: conn.inboxId,
        messageId: pending.id,
      });
      return;
    }
  }

  const chat = bb.chats?.[0];

  // Who the CONVERSATION belongs to, derived from the chat — never from this
  // message. An outbound message has no handle, so message-derived resolution
  // left every thread we spoke in first with no contact at all.
  const conversationContactId = await resolveConversationContact(chatGuid, chat);

  // Who wrote THIS message. Only inbound messages have an author contact.
  const authorContactId = bb.isFromMe
    ? null
    : bb.handle?.address
      ? // NOT `chat?.displayName` — the author is a person, and that string is
        // the chat's title. Passing it named every new participant of a named
        // group after the group itself, and the address-book sync then refused
        // to correct it because the name no longer looked like an address.
        ((await resolveContact(bb.handle.address))?.contactId ?? conversationContactId)
      : conversationContactId;

  const { conversation, created } = await ensureConversation(
    conn.inboxId,
    chatGuid,
    conversationContactId,
    { title: chat?.displayName },
  );

  // Self-heal rows created before the chat became the source of truth, and
  // rows whose first message arrived before the chat carried participants.
  if (!conversation.contactId && conversationContactId) {
    await db
      .update(conversations)
      .set({ contactId: conversationContactId })
      .where(and(eq(conversations.id, conversation.id), isNull(conversations.contactId)));
    conversation.contactId = conversationContactId;
  }

  await linkParticipants(conversation.id, chatGuid, chat).catch((err) =>
    log.warn({ err: (err as Error).message, chatGuid }, 'could not record participants'),
  );

  /**
   * What a text tapback is decorating.
   *
   * SMS tapbacks carry no reference to their target, only a quote of it, so
   * the newest message with exactly that body is the best available answer.
   * Wrong only when the same words were sent twice in one thread, where the
   * reaction lands on the later copy — which is also what a human reading the
   * quote would assume.
   */
  let associatedGuid = bb.associatedMessageGuid ?? null;
  if (!associatedGuid && textTapback?.target) {
    const target = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversation.id),
        eq(messages.body, textTapback.target),
        isNotNull(messages.providerMessageGuid),
      ),
      orderBy: [desc(messages.createdAt)],
      columns: { providerMessageGuid: true },
    });
    associatedGuid = target?.providerMessageGuid ?? null;
  }

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      providerMessageGuid: bb.guid,
      direction: bb.isFromMe ? 'outbound' : 'inbound',
      authorType: bb.isFromMe ? 'external' : 'contact',
      authorContactId,
      body: bb.text ?? null,
      subject: bb.subject ?? null,
      status: bb.isFromMe ? 'sent' : 'delivered',
      associatedMessageGuid: associatedGuid,
      reactionType: reaction,
      replyToMessageGuid: bb.threadOriginatorGuid ?? null,
      sentAt,
      deliveredAt: bbDate(bb.dateDelivered),
      readAt: bbDate(bb.dateRead),
    })
    .returning();

  if (!msg) return;
  await ingestAttachments(connectionId, msg.id, bb);

  // Bump conversation denormalized fields. Inbound reopens a closed ticket.
  const preview =
    bb.text?.slice(0, 280) ||
    (bb.attachments?.length
      ? bb.attachments.some((a) =>
          isVoiceMemoAttachment({ uti: a.uti, mimeType: a.mimeType, fileName: a.transferName }),
        )
        ? '🎤 Voice message'
        : '📎 Attachment'
      : '');
  const isInbound = !bb.isFromMe;

  /**
   * A tapback is an acknowledgement, not a message.
   *
   * It gets a row so the thread can render the heart, and that is all it
   * gets: no preview, no unread badge, no reordering the inbox, and it does
   * not pull a closed thread back open. Messages doesn't do any of those
   * either — loving a text is the lightest possible signal, and treating it
   * as traffic made "Loved \"not home!\"" the last thing a conversation
   * appeared to say.
   */
  if (!reaction) {
    await db
      .update(conversations)
      .set({
        lastMessageAt: sentAt,
        lastMessagePreview: preview,
        ...(isInbound ? { lastInboundAt: sentAt } : {}),
        // A muted thread keeps receiving messages but never counts them as
        // unread — no badge, no bold row, no sound. That's the whole feature.
        ...(isInbound && !conversation.mutedAt
          ? { unreadCount: (conversation.unreadCount ?? 0) + 1 }
          : {}),
        // An inbound message pulls the thread back into the inbox from wherever
        // it was filed. This matters most for SNOOZED: a snoozed conversation is
        // genuinely hidden, so without this a reply would sit unseen until the
        // wake time — which is exactly the message loss snoozing is supposed to
        // prevent. Every mail client wakes a snoozed thread on reply.
        ...(isInbound && (conversation.status === 'closed' || conversation.status === 'snoozed')
          ? { status: 'open' as const, snoozedUntil: null }
          : {}),
      })
      .where(eq(conversations.id, conversation.id));
  }

  await publishEvent({
    type: 'message.created',
    conversationId: conversation.id,
    inboxId: conn.inboxId,
    messageId: msg.id,
  });
  await publishEvent({
    type: 'conversation.updated',
    conversationId: conversation.id,
    inboxId: conn.inboxId,
  });

  // SLA clock / CSAT capture + per-message automations on every inbound
  // message. A tapback is excluded throughout: it is not a reply, so it must
  // not stop an SLA clock, count as a CSAT rating, trip an automation, or
  // reclassify who the correspondent is.
  if (isInbound && !reaction) {
    // Classify before automations run, so a rule can condition on the kind.
    await reclassifyKind(conversation.id, conversation).catch((err) =>
      log.warn({ err: (err as Error).message }, 'kind classification failed'),
    );
    if (authorContactId && bb.text) {
      await handleOptKeywords(conversation.id, authorContactId, bb.text).catch(() => {});
    }
    await onInboundSlaCsat(conversation.id, conversation, bb.text).catch(() => {});
    await runAutomations('message_received', conversation.id, { bodyText: bb.text }).catch(() => {});
    // Have a draft + summary waiting before an agent ever opens this.
    if (await isAiConfigured()) {
      await enqueueAi({ type: 'precompute', conversationId: conversation.id }).catch(() => {});
    }
  }

  // For a brand-new conversation: run new-conversation automations, then
  // auto-assign (if still unassigned) and auto-triage (if AI on).
  if (created && isInbound) {
    await runAutomations('conversation_created', conversation.id, { bodyText: bb.text }).catch(
      () => {},
    );
    await maybeAutoAssign(conversation.id, conn.inboxId).catch(() => {});
    if (await isAiConfigured()) {
      await enqueueAi({ type: 'triage', conversationId: conversation.id }).catch(() => {});
    }
  }
}

/** Ingest an `updated-message` event (delivered / read / edited / unsent). */
export async function ingestUpdatedMessage(connectionId: string, bb: BBMessage): Promise<void> {
  const db = getDb();
  if (!bb.guid) return;

  const existing = await db.query.messages.findFirst({
    where: eq(messages.providerMessageGuid, bb.guid),
  });
  if (!existing) {
    // We may not have seen the original yet; treat as a new message.
    return ingestNewMessage(connectionId, bb);
  }

  const delivered = bbDate(bb.dateDelivered);
  const read = bbDate(bb.dateRead);
  const edited = bbDate(bb.dateEdited);
  const retracted = bbDate(bb.dateRetracted);

  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
  });

  await db
    .update(messages)
    .set({
      deliveredAt: delivered ?? existing.deliveredAt,
      readAt: read ?? existing.readAt,
      editedAt: edited ?? existing.editedAt,
      retractedAt: retracted ?? existing.retractedAt,
      isEdited: existing.isEdited || Boolean(edited),
      isRetracted: existing.isRetracted || Boolean(retracted),
      body: edited ? (bb.text ?? existing.body) : existing.body,
      status: read ? 'read' : delivered ? 'delivered' : existing.status,
      error: bb.error ? `send error ${bb.error}` : existing.error,
    })
    .where(eq(messages.id, existing.id));

  if (conn) {
    await publishEvent({
      type: 'message.updated',
      conversationId: existing.conversationId,
      inboxId: conn.inboxId,
      messageId: existing.id,
    });
  }
}
