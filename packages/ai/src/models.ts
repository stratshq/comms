import { resolveBaseUrl, type ProviderType } from './provider.js';

/**
 * Ask a provider which models the key can actually reach.
 *
 * Typing an exact model id from memory is where connecting a provider fails,
 * and the failure is a 404 that names nothing. Every vendor here answers the
 * same question over HTTP, so the panel asks instead of guessing: paste the
 * key, get the list, pick one.
 *
 * Answers are not cached. This runs when someone clicks a button, and a
 * catalogue that is one release out of date is exactly the problem it exists
 * to solve.
 */

/** Model families that exist on these APIs but can't answer a chat prompt. */
const NON_CHAT = [
  'embedding',
  'embed',
  'tts',
  'whisper',
  'audio',
  'transcribe',
  'moderation',
  'rerank',
  'dall-e',
  'imagen',
  'veo',
  'image',
  'aqa',
];

/**
 * Drop what the caller could never select.
 *
 * A raw list from OpenAI or Google is mostly embedding and media models, and
 * burying four usable chat models among sixty is barely better than no list.
 * Substring matching is crude and will occasionally hide something usable,
 * which is why the field it feeds stays free text.
 */
function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT.some((n) => lower.includes(n));
}

interface ModelListResponse {
  data?: { id?: string | null }[];
  models?: { name?: string | null }[];
  error?: { message?: string };
}

async function getJson(url: string, headers: Record<string, string>): Promise<ModelListResponse> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as ModelListResponse;
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Provider returned HTTP ${res.status}`);
  }
  return data;
}

export async function fetchAvailableModels(input: {
  type: ProviderType;
  apiKey: string;
  baseUrl: string | null;
}): Promise<string[]> {
  const ids: string[] = [];

  if (input.type === 'anthropic') {
    // Defaults to 20 per page, which silently truncates the list — ask for
    // the maximum rather than showing a partial catalogue as if it were whole.
    const data = await getJson('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
    });
    ids.push(...(data.data ?? []).map((m) => m.id ?? '').filter(Boolean));
  } else {
    const base = resolveBaseUrl(input.type, input.baseUrl);
    if (!base) throw new Error('Set a base URL first.');
    const data = await getJson(`${base}/models`, {
      Authorization: `Bearer ${input.apiKey}`,
    });
    ids.push(
      ...(data.data ?? []).map((m) => m.id ?? '').filter(Boolean),
      // Google's compat layer returns ids prefixed `models/`; strip it so the
      // value is what /chat/completions expects back.
      ...(data.models ?? []).map((m) => m.name ?? '').filter(Boolean),
    );
  }

  const cleaned = ids
    .map((id) => id.replace(/^models\//, '').trim())
    .filter(Boolean)
    .filter(isChatModel);

  return Array.from(new Set(cleaned)).sort();
}
