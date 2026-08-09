import 'server-only';
import { asc, eq, sql, roleGrants } from '@comms/db';
import { aiProviders, channelConnections, inboxes, users } from '@comms/db';
import {
  QUEUE_NAMES,
  attachmentsQueue,
  aiQueue,
  inboundQueue,
  maintenanceQueue,
  outboundQueue,
  getRedis,
  loadConfig,
} from '@comms/core';
import { db } from '@/server/db';
import { getSetting, setSetting } from '@/server/settings';
import { isUpToDate } from '@/lib/version-compare';
import { version as APP_VERSION } from '../../package.json';

/**
 * Instance-level facts for the admin panel: what version this is, whether the
 * pieces are alive, what's configured. Everything here degrades to an honest
 * "couldn't check" — an admin page that throws is useless exactly when it's
 * needed.
 */

export { APP_VERSION };

const REPO = 'byw1/comms';
const VERSION_CACHE_KEY = 'version_check';
const VERSION_CACHE_MS = 6 * 60 * 60 * 1000;

export interface VersionInfo {
  current: string;
  /** Newest published release tag, or null when none exist / check failed. */
  latest: string | null;
  latestUrl: string | null;
  upToDate: boolean | null;
  checkedAt: string | null;
  /** Human note when latest is null ("no releases yet", "couldn't reach GitHub"). */
  note: string | null;
}

interface VersionCache {
  latest: string | null;
  latestUrl: string | null;
  note: string | null;
  checkedAt: string;
}

export async function getVersionInfo(force = false): Promise<VersionInfo> {
  let cached = await getSetting<VersionCache>(VERSION_CACHE_KEY);
  const stale =
    !cached?.checkedAt || Date.now() - new Date(cached.checkedAt).getTime() > VERSION_CACHE_MS;

  if (force || stale) {
    const fresh: VersionCache = {
      latest: null,
      latestUrl: null,
      note: null,
      checkedAt: new Date().toISOString(),
    };
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      });
      if (res.status === 404) {
        fresh.note = 'No releases published yet.';
      } else if (!res.ok) {
        fresh.note = `GitHub answered HTTP ${res.status}.`;
      } else {
        const data = (await res.json()) as { tag_name?: string; html_url?: string };
        fresh.latest = data.tag_name ?? null;
        fresh.latestUrl = data.html_url ?? null;
      }
    } catch {
      fresh.note = 'Could not reach GitHub to check.';
    }
    // A failed check must not erase a previous good answer.
    cached =
      fresh.latest === null && cached?.latest
        ? { ...cached, note: fresh.note, checkedAt: fresh.checkedAt }
        : fresh;
    await setSetting(VERSION_CACHE_KEY, cached);
  }

  const latest = cached?.latest ?? null;
  return {
    current: APP_VERSION,
    latest,
    latestUrl: cached?.latestUrl ?? null,
    upToDate: latest ? isUpToDate(APP_VERSION, latest) : null,
    checkedAt: cached?.checkedAt ?? null,
    note: cached?.note ?? null,
  };
}

// ---- Health -----------------------------------------------------------------

export interface SystemHealth {
  db: { ok: boolean; latencyMs: number | null; sizeBytes: number | null; error: string | null };
  redis: { ok: boolean; latencyMs: number | null; error: string | null };
  worker: { ok: boolean; lastSeenAt: string | null };
  queues: { name: string; waiting: number; active: number; delayed: number; failed: number }[];
  bridges: { inboxName: string; status: string; lastHeartbeatAt: string | null }[];
  storageConfigured: boolean;
  smtpConfigured: boolean;
  transcriptionConfigured: boolean;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const cfg = loadConfig();

  const dbHealth: SystemHealth['db'] = { ok: false, latencyMs: null, sizeBytes: null, error: null };
  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    dbHealth.latencyMs = Date.now() - t0;
    dbHealth.ok = true;
    const size = await db.execute(sql`select pg_database_size(current_database()) as size`);
    const row = (size as unknown as { rows?: { size?: string | number }[] }).rows?.[0];
    dbHealth.sizeBytes = row?.size != null ? Number(row.size) : null;
  } catch (err) {
    dbHealth.error = (err as Error).message;
  }

  const redisHealth: SystemHealth['redis'] = { ok: false, latencyMs: null, error: null };
  let workerAlive: string | null = null;
  try {
    const t0 = Date.now();
    await getRedis().ping();
    redisHealth.latencyMs = Date.now() - t0;
    redisHealth.ok = true;
    workerAlive = await getRedis().get('comms:worker:alive');
  } catch (err) {
    redisHealth.error = (err as Error).message;
  }

  // The worker refreshes its beacon every 60s with a 180s expiry, so a live
  // key IS the health check; how recent is just detail.
  const workerLastSeen = workerAlive ? new Date(Number(workerAlive)) : null;

  const queueHandles = [
    { name: QUEUE_NAMES.inbound, q: inboundQueue() },
    { name: QUEUE_NAMES.outbound, q: outboundQueue() },
    { name: QUEUE_NAMES.attachments, q: attachmentsQueue() },
    { name: QUEUE_NAMES.maintenance, q: maintenanceQueue() },
    { name: QUEUE_NAMES.ai, q: aiQueue() },
  ];
  const queues: SystemHealth['queues'] = [];
  for (const { name, q } of queueHandles) {
    try {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      queues.push({
        name: name.replace('comms-', ''),
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      });
    } catch {
      queues.push({ name: name.replace('comms-', ''), waiting: -1, active: -1, delayed: -1, failed: -1 });
    }
  }

  const bridgeRows = await db
    .select({
      inboxName: inboxes.name,
      status: channelConnections.status,
      lastHeartbeatAt: channelConnections.lastHeartbeatAt,
    })
    .from(channelConnections)
    .innerJoin(inboxes, eq(channelConnections.inboxId, inboxes.id))
    .catch(() => []);

  return {
    db: dbHealth,
    redis: redisHealth,
    worker: { ok: Boolean(workerAlive), lastSeenAt: workerLastSeen?.toISOString() ?? null },
    queues,
    bridges: bridgeRows.map((b) => ({
      inboxName: b.inboxName,
      status: b.status,
      lastHeartbeatAt: b.lastHeartbeatAt?.toISOString() ?? null,
    })),
    storageConfigured: cfg.storageEnabled,
    smtpConfigured: cfg.smtpEnabled,
    transcriptionConfigured: cfg.transcriptionEnabled,
  };
}

// ---- People (General tab) -----------------------------------------------------

export async function getAdminOverview() {
  const [allWithRole, recent] = await Promise.all([
    db.query.users.findMany({
      columns: { id: true, name: true, email: true, image: true },
      with: { role: { columns: { name: true, permissions: true } } },
      orderBy: [asc(users.name)],
    }),
    db.query.users.findMany({
      columns: { id: true, name: true, email: true, lastSeenAt: true, status: true },
      with: { role: { columns: { name: true } } },
      // Hand-rolled: desc() would render "nulls last desc", which is invalid.
      orderBy: [sql`${users.lastSeenAt} desc nulls last`, asc(users.name)],
      limit: 8,
    }),
  ]);
  // "Administrators" = anyone whose role grants system administration.
  const admins = allWithRole
    .filter((u) => roleGrants(u.role?.permissions, 'system.admin'))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, image: u.image, role: u.role?.name ?? '—' }));
  return {
    admins,
    recent: recent.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role?.name ?? '—',
      lastSeenAt: u.lastSeenAt,
      status: u.status,
    })),
  };
}

// ---- AI providers ---------------------------------------------------------------

/** Provider rows for the panel — keys stay encrypted and never leave the server. */
export async function listAiProvidersSafe() {
  const rows = await db.query.aiProviders.findMany({ orderBy: [asc(aiProviders.createdAt)] });
  const cfg = loadConfig();
  return {
    providers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      baseUrl: r.baseUrl,
      model: r.model,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    })),
    /** The zero-config fallback: an env key that applies when no row is active. */
    envAnthropicKey: Boolean(cfg.ANTHROPIC_API_KEY),
    envModel: cfg.AI_MODEL,
  };
}
