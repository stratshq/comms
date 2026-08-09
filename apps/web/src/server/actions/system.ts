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
