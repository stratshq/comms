import Anthropic from '@anthropic-ai/sdk';
import { getActiveProvider, type ResolvedProvider } from './provider.js';
import { compatJson, compatText } from './openai-compat.js';

/**
 * The two calls every feature reduces to — a text completion and a
 * structured extraction — dispatched over whichever provider is active.
 * Anthropic gets its native API (tool-use for structure, which is stronger
 * than JSON mode); everything else goes over the OpenAI-compatible dialect.
 */

let anthropicClient: { key: string; client: Anthropic } | null = null;

function getAnthropic(apiKey: string): Anthropic {
  if (anthropicClient?.key !== apiKey) {
    anthropicClient = { key: apiKey, client: new Anthropic({ apiKey }) };
  }
  return anthropicClient.client;
}

async function requireProvider(): Promise<ResolvedProvider> {
  const provider = await getActiveProvider();
  if (!provider) {
    throw new Error('AI is not configured (connect a provider in Settings → Admin panel).');
  }
  return provider;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

export interface AiTextInput {
  system: string;
  user: string;
  maxTokens: number;
  /** Bypass resolution — used by the admin panel's connection test. */
  provider?: ResolvedProvider;
}

export async function aiText(input: AiTextInput): Promise<string> {
  const provider = input.provider ?? (await requireProvider());

  if (provider.type === 'anthropic') {
    const res = await getAnthropic(provider.apiKey).messages.create({
      model: provider.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    });
    return extractText(res.content);
  }

  return compatText(
    { baseUrl: provider.baseUrl!, apiKey: provider.apiKey, model: provider.model },
    input,
  );
}

export interface AiStructuredInput {
  system: string;
  user: string;
  maxTokens: number;
  /** Anthropic tool definition — its input_schema doubles as the JSON shape elsewhere. */
  tool: Anthropic.Tool;
}

export async function aiStructured(input: AiStructuredInput): Promise<Record<string, unknown>> {
  const provider = await requireProvider();

  if (provider.type === 'anthropic') {
    const res = await getAnthropic(provider.apiKey).messages.create({
      model: provider.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
      tools: [input.tool],
      tool_choice: { type: 'tool' as const, name: input.tool.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    return (block && 'input' in block ? block.input : {}) as Record<string, unknown>;
  }

  return compatJson(
    { baseUrl: provider.baseUrl!, apiKey: provider.apiKey, model: provider.model },
    {
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      schemaDescription: JSON.stringify(input.tool.input_schema),
    },
  );
}

export { Anthropic };
