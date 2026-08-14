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

/**
 * A sensible default model per vendor.
 *
 * Mid-tier on purpose. Everything this product asks a model to do — summarise
 * a thread, draft a reply, classify a correspondent, group similar
 * conversations — runs on every inbound message, so the frontier model is
 * both overkill and the difference between a rounding error and a real bill.
 */
export const SUGGESTED_MODELS: Record<ProviderType, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.2',
  google: 'gemini-3.6-flash',
  xai: 'grok-4',
  custom: '',
};

/**
 * Model ids offered as suggestions when connecting a provider.
 *
 * Suggestions, not a whitelist: the field stays free text because vendors
 * ship new ids constantly and a closed list would make this panel the reason
 * you can't use a model that came out yesterday. It exists because typing an
 * exact id from memory is the step where connecting a provider actually
 * fails, and the resulting 404 says nothing useful.
 */
export const KNOWN_MODELS: Record<ProviderType, string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.2', 'gpt-5.2-mini'],
  google: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'],
  xai: ['grok-4', 'grok-4-fast'],
  custom: [],
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
