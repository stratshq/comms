import { Worker } from 'bullmq';
import {
  QUEUE_NAMES,
  createRedis,
  getRedis,
  loadConfig,
  enqueueAi,
  enqueueMaintenance,
  logger,
} from '@comms/core';
import { getDb, closeDb, ensureAppSecret } from '@comms/db';
import { channelConnections } from '@comms/db';
import { isAiConfigured } from '@comms/ai';
import { processInbound } from './processors/inbound.js';
import { processOutbound } from './processors/outbound.js';
import { processAttachment } from './processors/attachments.js';
import { processMaintenance } from './processors/maintenance.js';
import { processAiJob } from './processors/ai.js';

const log = logger.child({ service: 'worker' });

async function main() {
  // Self-provision the app secret from the DB when not provided, so the worker
  // and web share the same key with zero required config.
  if (!process.env.APP_SECRET && !process.env.AUTH_SECRET && process.env.DATABASE_URL) {
    process.env.APP_SECRET = await ensureAppSecret();
  }
  loadConfig(true); // fail fast if DB/Redis are missing
  getDb(); // warm the pool

  const workers: Worker[] = [
    new Worker(QUEUE_NAMES.inbound, processInbound, {
      connection: createRedis(),
      concurrency: 10,
    }),
    new Worker(QUEUE_NAMES.outbound, processOutbound, {
      connection: createRedis(),
      concurrency: 5,
    }),
    new Worker(QUEUE_NAMES.attachments, processAttachment, {
      connection: createRedis(),
      concurrency: 5,
    }),
    new Worker(QUEUE_NAMES.maintenance, processMaintenance, {
      connection: createRedis(),
      concurrency: 2,
    }),
    new Worker(QUEUE_NAMES.ai, processAiJob, {
      connection: createRedis(),
      concurrency: 3,
    }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) =>
      log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'),
    );
    w.on('error', (err) => log.error({ queue: w.name, err: err.message }, 'worker error'));
  }

  log.info('Comms worker started');

  /**
   * True at most once per `seconds`, across restarts and replicas.
   *
   * The obvious version — an in-memory tick counter with `tick % 60` — silently
   * stops working the moment the worker restarts more often than the interval:
   * the counter resets to zero and the hourly job simply never runs. Anchoring
   * on a Redis key with a TTL means a deploy can't starve a slow job.
   */
  const due = async (key: string, seconds: number) => {
    const set = await getRedis().set(`comms:due:${key}`, '1', 'EX', seconds, 'NX');
    return set !== null;
  };

  // Periodic sweep: heartbeat each connection + unsnooze due conversations, plus
  // a periodic reconcile backfill to heal any messages missed while the webhook
  // endpoint was down (BlueBubbles does not redeliver webhooks).
  // A short Redis lock ensures only one replica sweeps each tick.
  const sweep = async () => {
    const redis = getRedis();
    // Liveness beacon for the admin panel's Health tab — set by every replica
    // on every tick, before the single-sweeper lock, so "a worker is alive"
    // is answerable even when this replica isn't the one sweeping.
    await redis.set('comms:worker:alive', String(Date.now()), 'EX', 180).catch(() => {});
    const got = await redis.set('comms:sweep:lock', '1', 'PX', 55_000, 'NX');
    if (!got) return;
    try {
      await enqueueMaintenance({ type: 'unsnooze' });
      await enqueueMaintenance({ type: 'sla' });
      // Promises age slowly; checking them hourly is plenty.
      if (await due('nudges', 60 * 60)) {
        await enqueueMaintenance({ type: 'nudges' });
      }
      // Photos that arrived before this install had a bucket. Cheap and a
      // no-op with nothing pending, but the first tick after someone
      // configures storage is where every stranded image comes back.
      if (await due('retryAttachments', 10 * 60)) {
        await enqueueMaintenance({ type: 'retryAttachments' });
      }
      // Bundling costs a model call — hourly, and only when AI is configured
      // (env key or a provider connected in the admin panel).
      if ((await isAiConfigured()) && (await due('bundle', 60 * 60))) {
        await enqueueAi({ type: 'bundle' });
      }
      const conns = await getDb()
        .select({ id: channelConnections.id })
        .from(channelConnections);
      for (const c of conns) {
        await enqueueMaintenance({ type: 'heartbeat', connectionId: c.id });
        // Webhooks are the primary path; this is only a safety net for events
        // the Mac dropped while we were unreachable. Every 5 minutes was
        // aggressive enough to saturate the bridge on its own.
        if (await due(`backfill:${c.id}`, 30 * 60)) {
          await enqueueMaintenance({ type: 'backfill', connectionId: c.id });
        }
        // Address books change slowly — hourly is plenty.
        if (await due(`contacts:${c.id}`, 60 * 60)) {
          await enqueueMaintenance({ type: 'contactSync', connectionId: c.id });
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'sweep failed');
    }
  };

  // Data left broken by earlier bugs is repaired on boot rather than at the
  // next contact sync — an hour of rows labelled "Unknown contact" is an hour
  // too many, and both repairs are no-ops once the data is clean.
  // `classifyExisting` is the same idea for the split inbox: without it an
  // established install shows every old thread as a person until new traffic
  // arrives. `seedDefaultFolders` gives every install the split-inbox folders
  // out of the box. Both self-disable once complete.
  for (const type of [
    'repairNames',
    'repairContacts',
    'classifyExisting',
    'seedDefaultFolders',
  ] as const) {
    await enqueueMaintenance({ type }).catch((err) =>
      log.warn({ err: (err as Error).message, type }, 'could not enqueue repair'),
    );
  }

  await sweep();
  const interval = setInterval(() => void sweep(), 60_000);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    clearInterval(interval);
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err: err.message }, 'worker failed to start');
  process.exit(1);
});
