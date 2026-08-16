import type Anthropic from '@anthropic-ai/sdk';
import { aiStructured, aiText } from './client.js';
import { formatTranscript, RECENT_MARKER, type TranscriptMessage } from './transcript.js';

/**
 * How many trailing messages count as "the conversation you are in", as
 * opposed to the history behind it.
 *
 * Small on purpose. A thread that has been running for months is mostly about
 * things that already happened; the part you are actually replying to is the
 * last handful of texts.
 */
export const RECENT_WINDOW = 10;

/**
 * The rule every drafting prompt needs and none of them had.
 *
 * A long thread is not one topic — it is a stack of settled ones with a live
 * one on top. Left to itself the model treats the whole transcript as equally
 * true and answers a question that was resolved in March.
 */
const RECENCY_RULES = [
  `The transcript runs oldest to newest. Lines like [3 months ago] mark how old the messages beneath them are, and everything below "${RECENT_MARKER}" is the live exchange.`,
  "Reply to the LAST message. That is what is on the other person's mind; everything above it is background.",
  'Old messages describe a situation that has probably already resolved — plans were carried out, questions were answered, problems were fixed, people moved, things got bought. Never treat something raised months ago as still open or still pending unless the recent messages show that it is.',
  'Where old and recent context conflict, the recent context is the truth. Do not reintroduce old topics, old logistics or old questions.',
].join(' ');

/** How the reply should sound: like this thread, not like a template. */
const VOICE_RULES =
  'Match the register of the recent messages — their length, formality, punctuation and greeting habits. If the thread reads as quick casual texting between people who know each other, write like that; a polished paragraph in a thread of one-line texts is the wrong answer even when the content is right. Never invent facts, prices, dates, times, order numbers or commitments; if something is missing, ask for it.';

/** A tight catch-up summary for an agent opening a conversation. */
export async function summarizeConversation(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
  now?: Date;
}): Promise<string> {
  return aiText({
    maxTokens: 600,
    system:
      'You are an assistant for a customer-support team. Summarize the conversation so an agent can catch up in seconds. Lead with where things stand RIGHT NOW — the open ask and the current status — then only the older detail still needed to act on it. Age markers like [3 months ago] tell you what is stale; settled history is not worth a sentence. 2–4 sentences, plain text, no preamble.',
    user:
      formatTranscript(input.messages, input.contactName, { now: input.now }) || 'No messages yet.',
  });
}

/** Draft the next agent reply, optionally matched to the team's brand voice. */
export async function suggestReply(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
  brandVoiceExamples?: string[];
  guidance?: string;
  now?: Date;
}): Promise<string> {
  const parts = [
    formatTranscript(input.messages, input.contactName, {
      now: input.now,
      recentCount: RECENT_WINDOW,
    }) || 'No messages yet.',
  ];
  if (input.brandVoiceExamples?.length) {
    parts.push(
      '\n\nExamples of how our team writes (match this tone):\n' +
        input.brandVoiceExamples.map((e) => `- ${e}`).join('\n'),
    );
  }
  if (input.guidance) parts.push(`\n\nGuidance for this reply: ${input.guidance}`);

  return aiText({
    maxTokens: 800,
    system: [
      'You are drafting the next message to send in an ongoing conversation.',
      RECENCY_RULES,
      VOICE_RULES,
      'Output only the message body — no salutation placeholders, no subject line, no quotation marks, no commentary.',
    ].join(' '),
    user: parts.join(''),
  });
}

/**
 * Polish a reply the user has already written, rather than writing one for them.
 *
 * The safer half of the feature: the human has supplied the intent, the facts
 * and the commitments, so the model's only job is to make the wording better —
 * which is also the job it cannot get wrong in a way that reaches the customer
 * as a promise nobody made. Everything it must not do is spelled out, because
 * "improve" reads to a model as an invitation to add.
 */
export async function improveDraft(input: {
  contactName?: string | null;
  messages: TranscriptMessage[];
  draft: string;
  brandVoiceExamples?: string[];
  guidance?: string;
  now?: Date;
}): Promise<string> {
  const draft = input.draft.trim();
  if (!draft) return '';

  const parts = [
    formatTranscript(input.messages, input.contactName, {
      now: input.now,
      recentCount: RECENT_WINDOW,
    }) || 'No messages yet.',
  ];
  if (input.brandVoiceExamples?.length) {
    parts.push(
      '\n\nExamples of how our team writes (match this tone):\n' +
        input.brandVoiceExamples.map((e) => `- ${e}`).join('\n'),
    );
  }
  if (input.guidance) parts.push(`\n\nWhat to change: ${input.guidance}`);
  parts.push(`\n\nMy draft reply, to rewrite:\n"""\n${draft}\n"""`);

  const out = await aiText({
    maxTokens: 800,
    system: [
      'You rewrite a message the user has already drafted, so it reads better before they send it. The conversation is given for context only.',
      RECENCY_RULES,
      "Keep the draft's meaning, facts, numbers, dates, commitments and answers EXACTLY as written — they came from a person who knows things you do not.",
      'Do not add information, offers, questions, apologies, pleasantries or sign-offs that are not already there. Do not make it longer. Shorter is usually better.',
      'Fix wording, order, clarity, tone, typos and grammar only.',
      VOICE_RULES,
      'If the draft is already good, return it unchanged.',
      'Output only the rewritten message — no quotation marks, no commentary, no explanation of what you changed.',
    ].join(' '),
    user: parts.join(''),
  });

  // A model that answers with nothing, or wraps the message in the quotes it
  // was shown, must not silently eat what the user wrote. Curly quotes are in
  // the class too — a model handed `"""` often answers in typographic ones.
  const cleaned = out
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  return cleaned || draft;
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
  now?: Date;
}): Promise<ConversationTriage> {
  const data = (await aiStructured({
    maxTokens: 600,
    system:
      'You triage inbound customer-support conversations. Classify accurately and concisely. Judge the conversation by where it stands now, not by how it began: age markers like [3 months ago] mark history, and a thread that opened as urgent months ago is not urgent today unless the recent messages say so.',
    user: `Triage this conversation:\n\n${
      formatTranscript(input.messages, input.contactName, { now: input.now }) || 'No messages yet.'
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
      "You answer questions about the user's own text-message history.",
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
  now?: Date;
}): Promise<string> {
  const out = await aiText({
    maxTokens: 60,
    system: [
      'You complete the message the user is currently typing in a text-message thread.',
      'Output ONLY the continuation — the characters that follow their text. Do not repeat what they already wrote.',
      'Finish the current sentence and stop. At most about twelve words.',
      'Match their voice, casing and punctuation exactly. Texting is informal; do not make it more formal than the thread.',
      `The transcript runs oldest to newest; everything below "${RECENT_MARKER}" is the live exchange, and older messages describe things that have most likely already been settled.`,
      'Never invent facts, prices, dates, times or commitments. If the natural continuation would require a fact you do not have, output nothing.',
      'If their text already reads as complete, output nothing.',
    ].join(' '),
    user: `${
      formatTranscript(input.messages, input.contactName, {
        now: input.now,
        recentCount: RECENT_WINDOW,
      }) || 'No messages yet.'
    }\n\nI am typing this reply and stopped mid-thought:\n"${input.prefix}"\n\nContinuation:`,
  });
  // The model sometimes echoes the prefix despite the instruction.
  const cleaned = out.startsWith(input.prefix) ? out.slice(input.prefix.length) : out;
  return cleaned.replace(/^["']|["']$/g, '').trimEnd();
}
