import { DelayedError, type Job } from 'bullmq';
import {
  type OutboundJob,
  type BBSendMethod,
  getObjectBytes,
  publishEvent,
  awaitSendSlot,
  takeSendQuota,
  diagnoseConnectionError,
  type ConnectionProblem,
  loadConfig,
  logger,
} from '@comms/core';
import { getDb, eq, getRuntimeOverrides } from '@comms/db';
import { messages, conversations, contacts } from '@comms/db';
import { loadConnection } from '../lib/connection.js';
import { withChatLock } from '../lib/lock.js';

const log = logger.child({ module: 'outbound' });

/**
 * Failures that mean "the Mac isn't reachable right now" rather than "this
 * message can't be sent". A laptop that sleeps or hops wifi produces these
 * constantly, and the reply must survive until it wakes up.
 */
const TRANSIENT_PROBLEMS = new Set<ConnectionProblem>([
  'unreachable',
  'timeout',
  'dns',
  'refused',
  'server-error',
  'tls',
]);

/** How long to keep trying before admitting defeat. */
const MAX_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Back off as the outage lengthens: responsive to a brief blip, gentle on a
 * Mac that's been shut for the night. Derived from elapsed time rather than an
 * attempt counter, because parking a job doesn't increment BullMQ's.
 */
function retryDelayFor(elapsedMs: number): number {
  if (elapsedMs < 5 * 60_000) return 30_000;
  if (elapsedMs < 30 * 60_000) return 2 * 60_000;
  if (elapsedMs < 2 * 60 * 60_000) return 5 * 60_000;
  return 15 * 60_000;
}

export async function processOutbound(job: Job<OutboundJob>, token?: string): Promise<void> {
  const { messageId, connectionId } = job.data;
  const db = getDb();
  const cfg = loadConfig();

  const msg = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    with: { attachments: true },
  });
  if (!msg) {
    log.warn({ messageId }, 'outbound message not found; dropping');
    return;
  }
  // Idempotency: only send queued/failed messages, and never internal notes.
  if (msg.isPrivateNote || (msg.status !== 'queued' && msg.status !== 'failed')) return;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, msg.conversationId),
  });
  if (!conv) throw new Error(`conversation ${msg.conversationId} missing for outbound message`);

  // TCPA guard: a contact who replied STOP is never messaged again until they
  // reply START. Enforced here (not only in the UI) so no code path bypasses it.
  if (conv.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, conv.contactId),
      columns: { optedOutAt: true },
    });
    if (contact?.optedOutAt) {
      await db
        .update(messages)
        .set({ status: 'failed', error: 'Contact has opted out (replied STOP). Send blocked.' })
        .where(eq(messages.id, msg.id));
      await publishEvent({
        type: 'message.updated',
        conversationId: conv.id,
        inboxId: conv.inboxId,
        messageId: msg.id,
      });
      log.warn({ messageId: msg.id }, 'send blocked: contact opted out');
      return;
    }
  }

  // Apple-ID protection: hard hourly/daily ceilings per connection. Over cap,
  // the job parks itself until the window rolls over — delayed, never dropped.
  // Caps are admin-tunable at runtime; env values are the defaults.
  const overrides = await getRuntimeOverrides();
  const quota = await takeSendQuota(
    connectionId,
    overrides.sendHourlyCap ?? cfg.SEND_HOURLY_CAP,
    overrides.sendDailyCap ?? cfg.SEND_DAILY_CAP,
  );
  if (!quota.allowed) {
    log.warn(
      { messageId: msg.id, scope: quota.scope, retryInMs: quota.retryInMs },
      'send quota exhausted; delaying job',
    );
    await job.moveToDelayed(Date.now() + quota.retryInMs, token);
    throw new DelayedError();
  }

  const { client, connection } = await loadConnection(connectionId);
  const method: BBSendMethod = connection.capabilities?.privateApi ? 'private-api' : 'apple-script';

  await withChatLock(conv.id, async () => {
    await db.update(messages).set({ status: 'sending' }).where(eq(messages.id, msg.id));
    await publishEvent({
      type: 'message.updated',
      conversationId: conv.id,
      inboxId: connection.inboxId,
      messageId: msg.id,
    });

    try {
      // Pace sends per number to stay under Apple's iMessage throttling.
      await awaitSendSlot(connectionId, overrides.sendMinIntervalMs ?? cfg.SEND_MIN_INTERVAL_MS);

      const attachment = msg.attachments?.find((a) => a.storageKey);
      let providerGuid: string | undefined;

      if (attachment?.storageKey) {
        const bytes = await getObjectBytes(attachment.storageKey);
        const result = await client.sendAttachment({
          chatGuid: conv.providerChatGuid,
          tempGuid: msg.tempGuid!,
          file: bytes,
          fileName: attachment.fileName ?? 'attachment',
          contentType: attachment.mimeType ?? undefined,
          message: msg.body ?? undefined,
          method,
        });
        providerGuid = result?.guid;
      } else {
        const result = await client.sendText({
          chatGuid: conv.providerChatGuid,
          tempGuid: msg.tempGuid!,
          message: msg.body ?? '',
          method,
          selectedMessageGuid: msg.replyToMessageGuid ?? undefined,
        });
        providerGuid = result?.guid;
      }

      await db
        .update(messages)
        .set({
          status: 'sent',
          sentAt: new Date(),
          providerMessageGuid: providerGuid ?? msg.providerMessageGuid,
          error: null,
        })
        .where(eq(messages.id, msg.id));

      // Optionally clear the unread badge / send a read receipt on reply.
      const inboxSettings = (
        await db.query.inboxes.findFirst({ where: (i, { eq: e }) => e(i.id, conv.inboxId) })
      )?.settings;
      if (inboxSettings?.markReadOnReply) {
        await client.markRead(conv.providerChatGuid).catch(() => {});
      }

      await publishEvent({
        type: 'message.updated',
        conversationId: conv.id,
        inboxId: connection.inboxId,
        messageId: msg.id,
      });
    } catch (err) {
      const diagnosis = diagnoseConnectionError(err, connection.serverUrl);
      const transient = TRANSIENT_PROBLEMS.has(diagnosis.problem);
      const elapsed = Date.now() - (job.timestamp ?? Date.now());

      // A laptop running BlueBubbles sleeps, changes wifi, and rotates its
      // tunnel URL. Those are temporary conditions, not send failures — the
      // message must survive them. Park it and keep trying rather than
      // burning five retries in the first minute and giving up.
      if (transient && elapsed < MAX_RETRY_WINDOW_MS) {
        await db
          .update(messages)
          .set({ status: 'queued', error: `Waiting to send — ${diagnosis.message}` })
          .where(eq(messages.id, msg.id));
        await publishEvent({
          type: 'message.updated',
          conversationId: conv.id,
          inboxId: connection.inboxId,
          messageId: msg.id,
        });
        log.warn(
          { messageId: msg.id, problem: diagnosis.problem, elapsedMs: elapsed },
          'bridge unreachable; parking outbound message for retry',
        );
        await job.moveToDelayed(Date.now() + retryDelayFor(elapsed), token);
        throw new DelayedError();
      }

      const message = transient
        ? `Gave up after ${Math.round(MAX_RETRY_WINDOW_MS / 3_600_000)}h. ${diagnosis.message} ${diagnosis.hint}`
        : `${diagnosis.message} ${diagnosis.hint}`;
      await db
        .update(messages)
        .set({ status: 'failed', error: message })
        .where(eq(messages.id, msg.id));
      await publishEvent({
        type: 'message.updated',
        conversationId: conv.id,
        inboxId: connection.inboxId,
        messageId: msg.id,
      });
      log.error({ messageId: msg.id, err: (err as Error).message }, 'outbound send failed');
      throw err; // let BullMQ record the failure
    }
  });
}
