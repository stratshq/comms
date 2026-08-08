/**
 * Minimal OpenAI-compatible chat-completions transport.
 *
 * fetch-based on purpose: OpenAI, Google, xAI, Ollama, vLLM and OpenRouter
 * all speak this dialect, and the two calls this product makes (a text
 * completion, a JSON extraction) don't justify a vendor SDK each.
 */

export interface CompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

async function chat(
  cfg: CompatConfig,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Provider returned HTTP ${res.status}`);
  }
  return data.choices?.[0]?.message?.content ?? '';
}

export async function compatText(
  cfg: CompatConfig,
  input: { system: string; user: string; maxTokens: number },
): Promise<string> {
  const out = await chat(cfg, {
    max_tokens: input.maxTokens,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  });
  return out.trim();
}

/**
 * Pull a JSON object out of a model reply that may have wrapped it in prose
 * or a ```json fence. Exported for tests.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner) return inner;
  }

  // Last resort: the outermost brace span.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const span = tryParse(trimmed.slice(start, end + 1));
    if (span) return span;
  }
  return null;

  function tryParse(s: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * Structured output over the compat dialect.
 *
 * Asks for `response_format: json_object` and retries once WITHOUT it when
 * the provider rejects the parameter (some compat servers do), since the
 * schema is described in the prompt either way. The caller validates fields
 * — every feature in this package already treats model output defensively.
 */
export async function compatJson(
  cfg: CompatConfig,
  input: { system: string; user: string; schemaDescription: string; maxTokens: number },
): Promise<Record<string, unknown>> {
  const system = `${input.system}\n\nRespond with ONLY a JSON object, no prose, shaped exactly like:\n${input.schemaDescription}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: input.user },
  ];

  let out: string;
  try {
    out = await chat(cfg, {
      max_tokens: input.maxTokens,
      response_format: { type: 'json_object' },
      messages,
    });
  } catch {
    out = await chat(cfg, { max_tokens: input.maxTokens, messages });
  }

  const parsed = extractJsonObject(out);
  if (!parsed) throw new Error('Model did not return parseable JSON.');
  return parsed;
}
