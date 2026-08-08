import type Anthropic from '@anthropic-ai/sdk';
import { aiStructured, aiText } from './client.js';
import { formatTranscript, type TranscriptMessage } from './transcript.js';

/** A tight catch-up summary for an agent opening a conversation. */
export async function summarizeConversation(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
}): Promise<string> {
  return aiText({
    maxTokens: 600,
    system:
      "You are an assistant for a customer-support team. Summarize the conversation so an agent can catch up in seconds. Lead with the customer's core ask and the current status, then the key details. 2–4 sentences, plain text, no preamble.",
    user: formatTranscript(input.messages, input.contactName) || 'No messages yet.',
  });
}

/** Draft the next agent reply, optionally matched to the team's brand voice. */
export async function suggestReply(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
  brandVoiceExamples?: string[];
  guidance?: string;
}): Promise<string> {
  const parts = [formatTranscript(input.messages, input.contactName) || 'No messages yet.'];
  if (input.brandVoiceExamples?.length) {
    parts.push(
      '\n\nExamples of how our team writes (match this tone):\n' +
        input.brandVoiceExamples.map((e) => `- ${e}`).join('\n'),
    );
  }
  if (input.guidance) parts.push(`\n\nGuidance for this reply: ${input.guidance}`);

  return aiText({
    maxTokens: 800,
    system:
      "You are a customer-support agent drafting the next reply to send to the customer. Output only the message body — no salutation placeholders, no subject line, no quotation marks, no commentary. Be warm, concise, and genuinely helpful. Match the team's tone from any examples provided. Never invent facts, order numbers, prices, or commitments you cannot verify; if information is missing, ask the customer for it.",
    user: parts.join(''),
  });
}

export interface ConversationTriage {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  sentiment: 'positive' | 'neutral' | 'negative';
  topic: string;
  suggestedTags: string[];
  summary: string;
}

const TRIAGE_TOOL: Anthropic.Tool = {
  name: 'record_triage',
  description: 'Record the triage classification for this support conversation.',
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'urgent'],
        description: 'Urgency based on customer impact and tone.',
      },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      topic: { type: 'string', description: 'A 1–4 word topic, e.g. "Billing" or "Login issue".' },
      suggestedTags: {
        type: 'array',
        items: { type: 'string' },
        description: '0–5 short lowercase tags.',
      },
      summary: { type: 'string', description: 'One-sentence summary of the request.' },
    },
    required: ['priority', 'sentiment', 'topic', 'suggestedTags', 'summary'],
  },
};

/** Classify a conversation: priority, sentiment, topic, tags, one-line summary. */
export async function triageConversation(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
}): Promise<ConversationTriage> {
  const data = (await aiStructured({
    maxTokens: 600,
    system: 'You triage inbound customer-support conversations. Classify accurately and concisely.',
    user: `Triage this conversation:\n\n${
      formatTranscript(input.messages, input.contactName) || 'No messages yet.'
    }`,
    tool: TRIAGE_TOOL,
  })) as Partial<ConversationTriage>;
  return {
    priority: data.priority ?? 'normal',
    sentiment: data.sentiment ?? 'neutral',
    topic: (data.topic ?? '').slice(0, 60),
    suggestedTags: Array.isArray(data.suggestedTags)
      ? data.suggestedTags.slice(0, 5).map((t) => String(t).toLowerCase().slice(0, 30))
      : [],
    summary: (data.summary ?? '').slice(0, 400),
  };
}

export interface BundleCandidate {
  conversationId: string;
  /** Who the thread is with. */
  name: string;
  /** AI topic from triage, when available. */
  topic: string | null;
  /** Last message preview. */
  preview: string | null;
}

export interface BundleAssignment {
  conversationId: string;
  /** Bundle name to place the conversation in, or null to leave it alone. */
  bundle: string | null;
}

const BUNDLE_TOOL: Anthropic.Tool = {
  name: 'record_bundles',
  description: 'Record which bundle, if any, each conversation belongs to.',
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            conversationId: { type: 'string' },
            bundle: {
              type: ['string', 'null'],
              description:
                'Bundle name (1–3 words, Title Case), or null when the conversation fits no group.',
            },
          },
          required: ['conversationId', 'bundle'],
        },
      },
    },
    required: ['assignments'],
  },
};

/**
 * Group similar conversations into named bundles — the deciding half of
 * auto-labeling. The acting half already exists (tags, automations); this
 * call only says which threads belong together and what to call the group.
 *
 * The prompt is biased toward NOT bundling: a bundle with two loosely-related
 * threads costs more attention than it saves, and `null` is always allowed.
 */
export async function assignBundles(input: {
  candidates: BundleCandidate[];
  existingBundles: string[];
  /** Names the team dissolved — never recreate these. */
  forbiddenNames: string[];
}): Promise<BundleAssignment[]> {
  if (input.candidates.length === 0) return [];

  const lines = input.candidates
    .map(
      (c) =>
        `- id=${c.conversationId} · with ${c.name}${c.topic ? ` · topic: ${c.topic}` : ''}${
          c.preview ? ` · last: ${c.preview.slice(0, 120)}` : ''
        }`,
    )
    .join('\n');

  const data = (await aiStructured({
    maxTokens: 2000,
    system: [
      'You organize a shared text-message inbox by grouping similar conversations into bundles.',
      'A bundle is a short Title Case name like "Order Updates", "Scheduling", "Billing Questions".',
      'Reuse an existing bundle name whenever one fits. Only invent a new bundle when THREE or more conversations clearly share a theme.',
      'Most conversations belong to no bundle — assign null freely. Never bundle on superficial similarity.',
      input.forbiddenNames.length
        ? `Never use these bundle names (the team removed them): ${input.forbiddenNames.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    user: `Existing bundles: ${
      input.existingBundles.length ? input.existingBundles.join(', ') : '(none)'
    }\n\nConversations:\n${lines}`,
    tool: BUNDLE_TOOL,
  })) as {
    assignments?: Array<{ conversationId?: unknown; bundle?: unknown }>;
  };
  if (!Array.isArray(data.assignments)) return [];

  const known = new Set(input.candidates.map((c) => c.conversationId));
  const forbidden = new Set(input.forbiddenNames.map((n) => n.toLowerCase()));
  const out: BundleAssignment[] = [];
  for (const a of data.assignments) {
    const id = String(a.conversationId ?? '');
    if (!known.has(id)) continue;
    let bundle = a.bundle == null ? null : String(a.bundle).trim().slice(0, 40);
    if (bundle && forbidden.has(bundle.toLowerCase())) bundle = null;
    out.push({ conversationId: id, bundle: bundle || null });
  }
  return out;
}

/**
 * One excerpt handed to the archive Q&A, with enough context to be cited.
 */
export interface ArchiveExcerpt {
  conversationId: string;
  conversationName: string;
  at: string;
  direction: 'inbound' | 'outbound';
  body: string;
}

export interface ArchiveAnswer {
  answer: string;
  /**
   * The excerpt NUMBERS the model cited, in first-appearance order.
   *
   * Numbers rather than conversation ids: the answer text says [3], and the
   * source list has to be able to say [3] too. Collapsing to ids loses that.
   */
  citedIndexes: number[];
}

/**
 * Answer a question from excerpts of the message archive.
 *
 * Retrieval happens in SQL before this is called; the model's job is only to
 * read what it was given. The prompt is explicit that it must not answer from
 * general knowledge, because the failure mode people cannot detect is a
 * confident answer about their own messages that no message actually supports.
 */
export async function answerFromArchive(input: {
  question: string;
  excerpts: ArchiveExcerpt[];
}): Promise<ArchiveAnswer> {
  if (input.excerpts.length === 0) {
    return {
      answer: "I couldn't find anything in your messages about that.",
      citedIndexes: [],
    };
  }

  const context = input.excerpts
    .map(
      (e, i) =>
        `[${i + 1}] ${e.conversationName} · ${e.at} · ${
          e.direction === 'inbound' ? 'them' : 'you'
        }\n${e.body}`,
    )
    .join('\n\n');

  const answer = await aiText({
    maxTokens: 700,
    system: [
      'You answer questions about the user\'s own text-message history.',
      'You are given numbered excerpts retrieved from their messages. Answer ONLY from those excerpts.',
      'If the excerpts do not contain the answer, say so plainly and say what you did find instead — never fill the gap from general knowledge, and never guess at a number, date, price or commitment.',
      'Cite the excerpts you used inline as [1], [2]. Quote short fragments where the exact wording matters.',
      'Be direct and brief. No preamble, no restating the question.',
    ].join(' '),
    user: `Question: ${input.question}\n\nExcerpts from my messages:\n\n${context}`,
  });
  // Keep the numbers the model used, deduped, in the order it used them.
  const cited: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= input.excerpts.length && !cited.includes(n)) cited.push(n);
  }
  return { answer, citedIndexes: cited };
}

/**
 * Continue the sentence the user is part-way through typing.
 *
 * Deliberately short and deliberately conservative: a completion that runs on
 * past what someone meant to say is worse than no completion, because it is
 * accepted with one keystroke and sent to a real person.
 */
export async function completeMessage(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
  prefix: string;
}): Promise<string> {
  const out = await aiText({
    maxTokens: 60,
    system: [
      'You complete the message the user is currently typing in a text-message thread.',
      'Output ONLY the continuation — the characters that follow their text. Do not repeat what they already wrote.',
      'Finish the current sentence and stop. At most about twelve words.',
      'Match their voice, casing and punctuation exactly. Texting is informal; do not make it more formal than the thread.',
      'Never invent facts, prices, dates, times or commitments. If the natural continuation would require a fact you do not have, output nothing.',
      'If their text already reads as complete, output nothing.',
    ].join(' '),
    user: `${formatTranscript(input.messages, input.contactName) || 'No messages yet.'}\n\nI am typing this reply and stopped mid-thought:\n"${input.prefix}"\n\nContinuation:`,
  });
  // The model sometimes echoes the prefix despite the instruction.
  const cleaned = out.startsWith(input.prefix) ? out.slice(input.prefix.length) : out;
  return cleaned.replace(/^["']|["']$/g, '').trimEnd();
}
