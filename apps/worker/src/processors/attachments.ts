import type { Job } from 'bullmq';
import {
  type AttachmentJob,
  isStorageEnabled,
  putObject,
  publishEvent,
  sniffFormat,
  isVoiceMemoAttachment,
  extractAudioTranscript,
  isTranscriptionEnabled,
  transcribeAudio,
  logger,
} from '@comms/core';
import { getDb, eq, and, inArray } from '@comms/db';
import { attachments, messages, conversations } from '@comms/db';
import { loadConnection } from '../lib/connection.js';

const log = logger.child({ module: 'attachments' });

/**
 * Download, store, and (for voice memos) transcribe an attachment.
 *
 * Two renditions are kept when they differ: the ORIGINAL bytes exactly as the
 * Mac had them, and a browser-PLAYABLE version. This matters because iMessage
 * voice memos are Apple CAF, which no browser can play — and because
 * BlueBubbles labels them `audio/mp3` with a `.mp3` filename regardless, so
 * trusting the label silently produces an unplayable file.
 */
export async function processAttachment(job: Job<AttachmentJob>): Promise<void> {
  const { attachmentId, connectionId, providerAttachmentGuid } = job.data;
  const db = getDb();

  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, attachmentId) });
  if (!att) return;
  if (att.status === 'stored') return;

  if (!isStorageEnabled()) {
    /**
     * Leave it pending, not failed.
     *
     * This used to mark the row `failed`, which is terminal — so every photo
     * that arrived before someone configured a bucket was written off
     * permanently, and configuring one later brought none of them back. A
     * missing bucket is a deployment state, not a property of the
     * attachment; `retryPendingAttachments` picks these up once there is
     * somewhere to put them.
     */
    log.warn({ attachmentId }, 'object storage disabled; leaving attachment pending');
    return;
  }

  const { client } = await loadConnection(connectionId);

  // The original bytes, unconverted.
  const original = await client.downloadAttachment(providerAttachmentGuid, { original: true });
  const originalFormat = sniffFormat(original.bytes);

  const baseKey = `attachments/${att.messageId}/${attachmentId}`;
  const storageKey = `${baseKey}.${originalFormat.ext}`;
  await putObject(storageKey, original.bytes, originalFormat.mime);

  const isVoice = isVoiceMemoAttachment({
    uti: att.uti,
    mimeType: att.mimeType,
    fileName: att.fileName,
  });

  // A playable rendition, only when the original isn't already playable.
  let playableStorageKey = originalFormat.playable ? storageKey : null;
  let playableMimeType = originalFormat.playable ? originalFormat.mime : null;
  let playableBytes: Uint8Array | null = originalFormat.playable ? original.bytes : null;

  if (!originalFormat.playable) {
    // BlueBubbles converts audio server-side when `original` is omitted. It's
    // undocumented and version-dependent, so verify by sniffing rather than
    // assuming — a second copy of CAF helps nobody.
    try {
      const converted = await client.downloadAttachment(providerAttachmentGuid, {});
      const convertedFormat = sniffFormat(converted.bytes);
      if (convertedFormat.playable) {
        playableStorageKey = `${baseKey}.playable.${convertedFormat.ext}`;
        playableMimeType = convertedFormat.mime;
        playableBytes = converted.bytes;
        await putObject(playableStorageKey, converted.bytes, convertedFormat.mime);
      } else {
        log.info(
          { attachmentId, format: convertedFormat.ext },
          'server conversion did not yield a playable rendition',
        );
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'converted rendition download failed');
    }
  }

  await db
    .update(attachments)
    .set({
      status: 'stored',
      storageKey,
      playableStorageKey,
      playableMimeType,
      isVoiceMemo: isVoice,
      sizeBytes: att.sizeBytes ?? original.bytes.byteLength,
    })
    .where(eq(attachments.id, attachmentId));

  if (isVoice) {
    await transcribeVoiceMemo({
      attachmentId,
      messageId: att.messageId,
      connectionId,
      playableBytes,
      playableMimeType,
    }).catch((err) => log.warn({ err: (err as Error).message }, 'transcription failed'));
  }

  const msg = await db.query.messages.findFirst({
    columns: { id: true, conversationId: true },
    where: eq(messages.id, att.messageId),
  });
  if (msg) {
    const conv = await db.query.conversations.findFirst({
      columns: { inboxId: true },
      where: (c, { eq: e }) => e(c.id, msg.conversationId),
    });
    if (conv) {
      await publishEvent({
        type: 'message.updated',
        conversationId: msg.conversationId,
        inboxId: conv.inboxId,
        messageId: msg.id,
      });
    }
  }
}

/**
 * Two tiers, cheapest first.
 *
 * Tier 1 is Apple's own on-device transcript, which iOS 17+/Sonoma+ senders
 * already produced — free, instant, no vendor, and better at proper nouns
 * because it ran on the sender's device. Only on a miss do we spend money.
 */
async function transcribeVoiceMemo(input: {
  attachmentId: string;
  messageId: string;
  connectionId: string;
  playableBytes: Uint8Array | null;
  playableMimeType: string | null;
}): Promise<void> {
  const db = getDb();

  const msg = await db.query.messages.findFirst({
    columns: { id: true, providerMessageGuid: true, body: true, conversationId: true },
    where: eq(messages.id, input.messageId),
  });

  // ---- Tier 1: Apple's transcript, carried in the message's attributedBody.
  if (msg?.providerMessageGuid) {
    try {
      const { client } = await loadConnection(input.connectionId);
      const full = await client.getMessage(msg.providerMessageGuid, {
        with: ['attachment', 'attributedBody'],
      });
      const transcript = extractAudioTranscript(
        (full as unknown as { attributedBody?: unknown }).attributedBody,
      );
      if (transcript) {
        await saveTranscript(input.attachmentId, msg, transcript, 'apple');
        log.info({ attachmentId: input.attachmentId }, 'used Apple on-device transcript');
        return;
      }
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'attributedBody refetch failed');
    }
  }

  // ---- Tier 2: a speech provider, only if the operator configured one.
  if (!isTranscriptionEnabled() || !input.playableBytes) return;

  const result = await transcribeAudio({
    bytes: input.playableBytes,
    fileName: `voice-memo.${input.playableMimeType?.includes('mp4') ? 'm4a' : 'mp3'}`,
    mimeType: input.playableMimeType ?? 'audio/mpeg',
  });
  if (result && msg) {
    await saveTranscript(input.attachmentId, msg, result.text, result.provider);
    log.info({ attachmentId: input.attachmentId, provider: result.provider }, 'transcribed');
  }
}

/**
 * Persist the transcript on the attachment AND fold it into the message body,
 * so search, AI summaries, drafts and automations all see it as ordinary text
 * with no changes anywhere else.
 */
async function saveTranscript(
  attachmentId: string,
  msg: { id: string; body: string | null; conversationId: string },
  transcript: string,
  source: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(attachments)
    .set({ transcript, transcriptSource: source })
    .where(eq(attachments.id, attachmentId));

  if (!msg.body?.trim()) {
    await db.update(messages).set({ body: transcript }).where(eq(messages.id, msg.id));
    // Keep the conversation-list preview in step, but never clobber a real one.
    await db
      .update(conversations)
      .set({ lastMessagePreview: `🎤 ${transcript.slice(0, 260)}` })
      .where(
        and(
          eq(conversations.id, msg.conversationId),
          inArray(conversations.lastMessagePreview, ['', '📎 Attachment']),
        ),
      );
  }
}
