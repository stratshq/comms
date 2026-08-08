import { eq } from '@comms/db';
import { getDb, aiProviders } from '@comms/db';
import { decryptSecret, loadConfig } from '@comms/core';

/**
 * Which model answers, and over which wire.
 *
 * Resolution order: the provider an admin activated in the panel, else the
 * environment's ANTHROPIC_API_KEY. The env fallback is what keeps existing
 * installs working untouched — connecting a provider in the UI is an
 * override, not a migration.
 */

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'xai' | 'custom';

export interface ResolvedProvider {
  type: ProviderType;
  apiKey: string;
  /** Fully resolved base URL for OpenAI-compatible providers; unused for Anthropic. */
  baseUrl: string | null;
  model: string;
  /** Where this configuration came from — shown in the admin panel. */
  source: 'panel' | 'environment';
}

/**
 * Every non-Anthropic vendor here exposes the OpenAI chat-completions
 * dialect at a stable base URL; 'custom' supplies its own.
 */
export const DEFAULT_BASE_URLS: Record<Exclude<ProviderType, 'anthropic' | 'custom'>, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
};

/** Sensible starting models per vendor, offered as placeholders in the UI. */
export const SUGGESTED_MODELS: Record<ProviderType, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-5.2',
  google: 'gemini-3-pro',
  xai: 'grok-4',
  custom: '',
};

export function resolveBaseUrl(type: ProviderType, baseUrl: string | null): string | null {
  if (type === 'anthropic') return null;
  if (baseUrl?.trim()) return baseUrl.trim().replace(/\/$/, '');
  if (type === 'custom') return null;
  return DEFAULT_BASE_URLS[type];
}

// The active provider is consulted on every AI call; a short cache keeps
// that off the database. Writes from the admin panel bust it via
// resetProviderCache (same process) or just wait out the TTL (the worker).
let cache: { value: ResolvedProvider | null; at: number } | null = null;
const CACHE_MS = 30_000;

export function resetProviderCache() {
  cache = null;
}

export async function getActiveProvider(): Promise<ResolvedProvider | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let resolved: ResolvedProvider | null = null;

  try {
    const row = await getDb().query.aiProviders.findFirst({
      where: eq(aiProviders.isActive, true),
    });
    if (row) {
      resolved = {
        type: row.type,
        apiKey: decryptSecret(row.apiKeyEncrypted, loadConfig().appSecret),
        baseUrl: resolveBaseUrl(row.type, row.baseUrl),
        model: row.model,
        source: 'panel',
      };
    }
  } catch {
    // No database (build time, misconfigured) — fall through to env.
  }

  if (!resolved) {
    const cfg = loadConfig();
    if (cfg.ANTHROPIC_API_KEY) {
      resolved = {
        type: 'anthropic',
        apiKey: cfg.ANTHROPIC_API_KEY,
        baseUrl: null,
        model: cfg.AI_MODEL,
        source: 'environment',
      };
    }
  }

  cache = { value: resolved, at: Date.now() };
  return resolved;
}

/** Is any AI configured — panel provider or environment key? */
export async function isAiConfigured(): Promise<boolean> {
  return (await getActiveProvider()) !== null;
}
