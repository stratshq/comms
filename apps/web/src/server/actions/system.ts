'use server';

import { revalidatePath } from 'next/cache';
import { eq } from '@comms/db';
import {
  aiProviders,
  setRuntimeOverrides,
  clampRuntimeOverrides,
  type RuntimeOverrides,
} from '@comms/db';
import { encryptSecret, decryptSecret, loadConfig } from '@comms/core';
import {
  aiText,
  resetProviderCache,
  resolveBaseUrl,
  type ProviderType,
  type ResolvedProvider,
} from '@comms/ai';
import { db } from '@/server/db';
import { requirePermission } from '@/lib/session';
import { getVersionInfo } from '@/server/system';
import { saveSmtpSettings, clearSmtpSettings, sendMail } from '@/server/smtp';
import { activateLicense, deactivateLicense } from '@/server/license';

export type SystemResult = { ok: true } | { ok: false; error: string };

const PROVIDER_TYPES: ProviderType[] = ['anthropic', 'openai', 'google', 'xai', 'custom'];

/** Connect a provider. The key is encrypted with the app secret at rest. */
export async function addAiProvider(input: {
  name: string;
  type: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  makeActive?: boolean;
}): Promise<SystemResult> {
  await requirePermission('system.admin');

  const type = input.type as ProviderType;
  if (!PROVIDER_TYPES.includes(type)) return { ok: false, error: 'Unknown provider type.' };
  const name = input.name.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  const baseUrl = input.baseUrl?.trim() || null;
  if (!name) return { ok: false, error: 'Give the provider a name.' };
  if (!apiKey) return { ok: false, error: 'An API key is required.' };
  if (!model) return { ok: false, error: 'A model id is required.' };
  if (type === 'custom' && !baseUrl) {
    return { ok: false, error: 'A custom provider needs its OpenAI-compatible base URL.' };
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: 'Base URL must start with http(s)://.' };
  }

  // The first provider connected becomes active — connecting one and having
  // nothing change would read as broken.
  const existing = await db.query.aiProviders.findFirst({
    where: eq(aiProviders.isActive, true),
  });
  const makeActive = input.makeActive ?? !existing;

  if (makeActive) {
    await db.update(aiProviders).set({ isActive: false }).where(eq(aiProviders.isActive, true));
  }
  await db.insert(aiProviders).values({
    name,
    type,
    apiKeyEncrypted: encryptSecret(apiKey, loadConfig().appSecret),
    baseUrl,
    model,
    isActive: makeActive,
  });

  resetProviderCache();
  revalidatePath('/settings/admin');
  return { ok: true };
}

/** Make one provider the active one (or none, passing null). */
export async function setActiveAiProvider(id: string | null): Promise<SystemResult> {
  await requirePermission('system.admin');
  await db.update(aiProviders).set({ isActive: false }).where(eq(aiProviders.isActive, true));
  if (id) {
    const row = await db.query.aiProviders.findFirst({ where: eq(aiProviders.id, id) });
    if (!row) return { ok: false, error: 'Provider not found.' };
    await db.update(aiProviders).set({ isActive: true }).where(eq(aiProviders.id, id));
  }
  resetProviderCache();
  revalidatePath('/settings/admin');
  return { ok: true };
}

export async function deleteAiProvider(id: string): Promise<SystemResult> {
  await requirePermission('system.admin');
  await db.delete(aiProviders).where(eq(aiProviders.id, id));
  resetProviderCache();
  revalidatePath('/settings/admin');
  return { ok: true };
}

export type TestResult =
  | { ok: true; latencyMs: number; reply: string }
  | { ok: false; error: string };

/**
 * Round-trip a tiny prompt through a saved provider. The one thing every
 * admin does right after pasting a key, built in so they don't have to send
 * a real customer-facing draft to find out the key is wrong.
 */
export async function testAiProvider(id: string): Promise<TestResult> {
  await requirePermission('system.admin');
  const row = await db.query.aiProviders.findFirst({ where: eq(aiProviders.id, id) });
  if (!row) return { ok: false, error: 'Provider not found.' };

  const provider: ResolvedProvider = {
    type: row.type,
    apiKey: decryptSecret(row.apiKeyEncrypted, loadConfig().appSecret),
    baseUrl: resolveBaseUrl(row.type, row.baseUrl),
    model: row.model,
    source: 'panel',
  };

  const t0 = Date.now();
  try {
    const reply = await aiText({
      provider,
      maxTokens: 20,
      system: 'Reply with exactly: ok',
      user: 'Connection test.',
    });
    return { ok: true, latencyMs: Date.now() - t0, reply: reply.slice(0, 40) || '(empty reply)' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Save the runtime-tunable config knobs (Config tab). */
export async function saveRuntimeOverrides(input: RuntimeOverrides): Promise<SystemResult> {
  await requirePermission('system.admin');
  await setRuntimeOverrides(clampRuntimeOverrides(input));
  revalidatePath('/settings/admin');
  return { ok: true };
}

/** Force a fresh "is there a newer version" check. */
export async function recheckVersion(): Promise<SystemResult> {
  await requirePermission('system.admin');
  await getVersionInfo(true);
  revalidatePath('/settings/admin');
  return { ok: true };
}

// ---- Email (Config tab) ---------------------------------------------------

/**
 * Save SMTP settings to the database, where they override the environment and
 * apply to the next message without a redeploy.
 */
export async function saveEmailSettings(input: {
  host: string;
  port: number;
  user?: string;
  /** Omit to keep the stored password; '' clears it. */
  password?: string;
  from: string;
  secure?: boolean;
}): Promise<SystemResult> {
  await requirePermission('system.admin');
  const host = input.host.trim();
  const from = input.from.trim();
  if (!host) return { ok: false, error: 'SMTP host is required.' };
  if (!from.includes('@')) return { ok: false, error: 'From address must be an email address.' };
  const port = Number(input.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535.' };
  }

  await saveSmtpSettings({ ...input, host, from, port });
  revalidatePath('/settings/admin');
  return { ok: true };
}

/** Drop the database override and fall back to the environment variables. */
export async function clearEmailSettings(): Promise<SystemResult> {
  await requirePermission('system.admin');
  await clearSmtpSettings();
  revalidatePath('/settings/admin');
  return { ok: true };
}

/**
 * Prove the settings work by actually sending a message. A "test" that only
 * opened a TCP connection would pass for a mailbox that silently rejects every
 * send, which is the failure people actually hit.
 */
export async function sendTestEmail(to: string): Promise<SystemResult> {
  await requirePermission('system.admin');
  const address = to.trim();
  if (!address.includes('@')) return { ok: false, error: 'Enter a valid email address.' };

  const res = await sendMail({
    to: address,
    subject: 'Comms test email',
    text:
      'This is a test message from your Comms instance.\n\n' +
      'If you received it, email settings are working and invites will send.',
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---- Enterprise licence (Enterprise tab) ----------------------------------

export async function saveLicenseKey(input: {
  key: string;
  label?: string;
}): Promise<SystemResult> {
  await requirePermission('system.admin');
  const key = input.key.trim();
  if (key.length < 8) return { ok: false, error: 'That does not look like a licence key.' };
  await activateLicense(key, input.label);
  revalidatePath('/settings/admin');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function removeLicenseKey(): Promise<SystemResult> {
  await requirePermission('system.admin');
  await deactivateLicense();
  revalidatePath('/settings/admin');
  revalidatePath('/', 'layout');
  return { ok: true };
}
