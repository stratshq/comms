import { Queue, type JobsOptions } from 'bullmq';
import { createRedis } from './redis.js';

// NOTE: BullMQ forbids ':' in queue names (it's the Redis key separator), so use hyphens.
export const QUEUE_NAMES = {
  inbound: 'comms-inbound',
  outbound: 'comms-outbound',
  attachments: 'comms-attachments',
  maintenance: 'comms-maintenance',
  ai: 'comms-ai',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---- Job payloads -----------------------------------------------------------

/** A raw BlueBubbles webhook/socket event handed to the inbound processor. */
export interface InboundJob {
  connectionId: string;
  type: string; // 'new-message' | 'updated-message' | 'typing-indicator' | …
  data: unknown; // the BlueBubbles event payload
  receivedAt: number;
}

/** Send a previously-persisted (queued) message out through the provider. */
export interface OutboundJob {
  messageId: string;
  conversationId: string;
  connectionId: string;
}

/** Download an attachment from the provider and store it in S3. */
export interface AttachmentJob {
  attachmentId: string;
  connectionId: string;
  providerAttachmentGuid: string;
}

export type MaintenanceJob =
  | { type: 'backfill'; connectionId: string; since?: number }
  | { type: 'heartbeat'; connectionId: string }
  | { type: 'unsnooze' }
  | { type: 'sla' }
  /** Delete + re-create the webhook (after a URL change or event-list change). */
  | { type: 'reregister'; connectionId: string }
  /** Pull contacts (names + avatars) from the Mac's address book. */
  | { type: 'contactSync'; connectionId: string }
  /** Reset blank names written before the empty-string fallthrough was fixed. */
  | { type: 'repairNames' }
  /** Attach contacts to conversations that never got one from a message handle. */
  | { type: 'repairContacts' }
  /** Scan recent outbound replies for broken promises ("I'll send it Friday"). */
  | { type: 'nudges' }
  /** Re-download attachments that never reached object storage. */
  | { type: 'retryAttachments' }
  /** One-time: classify conversations that predate the correspondent detector. */
  | { type: 'classifyExisting' }
  /** One-time: create the default split-inbox folders. */
  | { type: 'seedDefaultFolders' };

/**
 * Background AI work. `precompute` runs on every inbound message so the draft
 * reply and catch-up summary are already waiting when an agent opens the
 * conversation — the difference between "click and wait" and Tab-to-accept.
 */
export type AiJob =
  | { type: 'triage'; conversationId: string }
  | { type: 'precompute'; conversationId: string }
  /** Group active conversations into named bundles (Shortwave-style). */
  | { type: 'bundle' };

// ---- Queue singletons -------------------------------------------------------

const queues = new Map<string, Queue>();

function getQueue<T>(name: QueueName): Queue<T> {
  const existing = queues.get(name);
  if (existing) return existing as unknown as Queue<T>;
  const q = new Queue(name, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600 },
    },
  });
  queues.set(name, q);
  return q as unknown as Queue<T>;
}

export const inboundQueue = () => getQueue<InboundJob>(QUEUE_NAMES.inbound);
export const outboundQueue = () => getQueue<OutboundJob>(QUEUE_NAMES.outbound);
export const attachmentsQueue = () => getQueue<AttachmentJob>(QUEUE_NAMES.attachments);
export const maintenanceQueue = () => getQueue<MaintenanceJob>(QUEUE_NAMES.maintenance);
export const aiQueue = () => getQueue<AiJob>(QUEUE_NAMES.ai);

export async function enqueueInbound(job: InboundJob, opts?: JobsOptions) {
  return inboundQueue().add('inbound', job, opts);
}

export async function enqueueOutbound(job: OutboundJob, opts?: JobsOptions) {
  // Hint ordering by conversation; true per-chat serialization is enforced by a
  // Redis lock in the worker processor.
  return outboundQueue().add('outbound', job, opts);
}

export async function enqueueAttachment(job: AttachmentJob, opts?: JobsOptions) {
  return attachmentsQueue().add('attachment', job, opts);
}

export async function enqueueMaintenance(job: MaintenanceJob, opts?: JobsOptions) {
  return maintenanceQueue().add('maintenance', job, opts);
}

export async function enqueueAi(job: AiJob, opts?: JobsOptions) {
  return aiQueue().add('ai', job, opts);
}

export { Queue };
