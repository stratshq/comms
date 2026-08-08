import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { appSettings } from './schema/system.js';

/**
 * Runtime-tunable settings, editable from the admin panel's Config tab.
 *
 * Environment variables need a redeploy and are invisible to anyone who
 * isn't holding the Railway dashboard. These few knobs are the ones an
 * operator actually reaches for while the app is running, so they live in
 * the database as overrides on top of the env defaults — unset means "use
 * whatever the environment says", exactly as before.
 *
 * Deliberately a safelist, not a general env editor: most configuration
 * (datastores, secrets, OAuth) genuinely belongs to the deployment, and a
 * UI that pretends to edit it would be lying about when the change applies.
 */
export interface RuntimeOverrides {
  /** Undo window for outbound replies, in seconds. */
  undoSendSeconds?: number;
  /** Apple-ID protection ceilings, per connection. */
  sendHourlyCap?: number;
  sendDailyCap?: number;
  /** Minimum pause between sends on one number, in milliseconds. */
  sendMinIntervalMs?: number;
}

const KEY = 'runtime_overrides';

/** Bounds keep a typo from becoming an outage (undo of 10^9 seconds, cap of 0). */
const LIMITS: Record<keyof RuntimeOverrides, { min: number; max: number }> = {
  undoSendSeconds: { min: 0, max: 120 },
  sendHourlyCap: { min: 1, max: 1000 },
  sendDailyCap: { min: 1, max: 10000 },
  sendMinIntervalMs: { min: 0, max: 60_000 },
};

export function clampRuntimeOverrides(input: RuntimeOverrides): RuntimeOverrides {
  const out: RuntimeOverrides = {};
  for (const [key, range] of Object.entries(LIMITS) as [
    keyof RuntimeOverrides,
    { min: number; max: number },
  ][]) {
    const v = input[key];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    out[key] = Math.min(range.max, Math.max(range.min, Math.round(v)));
  }
  return out;
}

/**
 * Read the stored overrides. A short cache keeps this off the hot send path
 * — the outbound processor consults it on every job.
 */
let cache: { value: RuntimeOverrides; at: number } | null = null;
const CACHE_MS = 15_000;

export async function getRuntimeOverrides(): Promise<RuntimeOverrides> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const db = getDb();
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, KEY) });
  const value = clampRuntimeOverrides((row?.value as RuntimeOverrides) ?? {});
  cache = { value, at: Date.now() };
  return value;
}

/** Replace the stored overrides (the admin panel sends the full set). */
export async function setRuntimeOverrides(input: RuntimeOverrides): Promise<RuntimeOverrides> {
  const value = clampRuntimeOverrides(input);
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  cache = { value, at: Date.now() };
  return value;
}

/** Tests only. */
export function resetRuntimeOverridesCache() {
  cache = null;
}
