import { pgTable, text, boolean, index } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';

/**
 * A configured AI provider — connected from the admin panel rather than the
 * environment, so a self-hoster can turn AI on (or switch vendors) without a
 * redeploy.
 *
 * `type` picks the wire protocol: 'anthropic' speaks the Anthropic API;
 * everything else ('openai', 'google', 'xai', 'custom') speaks the
 * OpenAI-compatible chat-completions dialect those vendors all expose.
 * A custom provider is just "OpenAI-compatible at this base URL" — which
 * covers Ollama, vLLM, OpenRouter, and whatever ships next month.
 *
 * At most one row is active. The environment's ANTHROPIC_API_KEY still works
 * as the zero-config fallback when no row is active, so existing installs
 * change behaviour only when an admin says so.
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: text('id').primaryKey().$defaultFn(genId('aip')),
    /** Display name, e.g. "Anthropic production" or "Local Ollama". */
    name: text('name').notNull(),
    type: text('type', { enum: ['anthropic', 'openai', 'google', 'xai', 'custom'] }).notNull(),
    /** AES-GCM encrypted with the app secret — same treatment as BlueBubbles credentials. */
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    /** Required for 'custom'; the known vendors have built-in defaults. */
    baseUrl: text('base_url'),
    /** Model id in the provider's own naming, e.g. claude-opus-4-8 or gpt-5.2. */
    model: text('model').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    ...timestamps,
  },
  (p) => [index('ai_providers_active_idx').on(p.isActive)],
);
