'use server';

import { and, asc, desc, eq, inArray, sql } from '@comms/db';
import { contacts, conversations, messages } from '@comms/db';
import {
  answerFromArchive,
  completeMessage,
  isAiEnabled,
  summarizeConversation,
  suggestReply,
  type TranscriptMessage,
} from '@comms/ai';
import { db } from '@/server/db';
import { requireUser } from '@/lib/session';
import { conversationName } from '@/lib/naming';

export type AiResult = { ok: true; text: string } | { ok: false; error: string };

async function loadTranscript(
  conversationId: string,
): Promise<{ contactName: string | null; transcript: TranscriptMessage[] } | null> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { contact: { columns: { displayName: true } } },
  });
  if (!conv) return null;

  const rows = await db.query.messages.findMany({
    where: and(eq(messages.conversationId, conversationId), eq(messages.isRetracted, false)),
    orderBy: [asc(messages.createdAt)],
    limit: 40,
    with: { authorUser: { columns: { name: true } } },
  });

  const transcript: TranscriptMessage[] = rows
    .filter((m) => m.authorType !== 'system' && (m.body ?? '').trim())
    .map((m) => ({
      role: m.authorType === 'contact' ? 'contact' : m.isPrivateNote ? 'note' : 'agent',
      author: m.authorUser?.name ?? null,
      text: m.body ?? '',
    }));

  return { contactName: conv.contact?.displayName ?? null, transcript };
}

export async function summarizeConversationAction(conversationId: string): Promise<AiResult> {
  await requireUser();
  if (!isAiEnabled()) return { ok: false, error: 'AI is not configured.' };
  const data = await loadTranscript(conversationId);
  if (!data) return { ok: false, error: 'Conversation not found.' };
  if (data.transcript.length === 0) return { ok: false, error: 'Nothing to summarize yet.' };
  try {
    const text = await summarizeConversation({
      contactName: data.contactName,
      messages: data.transcript,
    });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function suggestReplyAction(conversationId: string): Promise<AiResult> {
  await requireUser();
  if (!isAiEnabled()) return { ok: false, error: 'AI is not configured.' };
  const data = await loadTranscript(conversationId);
  if (!data) return { ok: false, error: 'Conversation not found.' };

  // Brand-voice examples: recent real agent replies (not internal notes).
  const recent = await db.query.messages.findMany({
    where: and(
      eq(messages.direction, 'outbound'),
      eq(messages.authorType, 'agent'),
      eq(messages.isPrivateNote, false),
    ),
    orderBy: [desc(messages.createdAt)],
    limit: 8,
    columns: { body: true },
  });
  const brandVoiceExamples = recent
    .map((m) => m.body?.trim())
    .filter((b): b is string => Boolean(b))
    .slice(0, 6);

  try {
    const text = await suggestReply({
      contactName: data.contactName,
      messages: data.transcript,
      brandVoiceExamples,
    });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Words too common to be worth treating as somebody's name. */
const STOP_WORDS = new Set([
  'what','when','where','who','why','how','did','does','do','the','and','for','about','with',
  'that','this','from','they','them','their','said','say','says','tell','told','was','were',
  'his','her','our','your','you','are','can','could','would','should','has','have','had','any',
  'all','get','got','me','my','it','is','on','in','of','to','at','a','an','last','ago','back',
]);

export interface ArchiveSource {
  /** The citation number used in the answer text — NOT a list position. */
  index: number;
  conversationId: string;
  conversationName: string;
  at: string;
  snippet: string;
}

export type AskResult =
  | { ok: true; answer: string; sources: ArchiveSource[] }
  | { ok: false; error: string };

/**
 * Answer a question from the whole message archive.
 *
 * Retrieval is Postgres full-text search over message bodies, ranked — the
 * same index the conversation search already uses, rather than a second search
 * path that could disagree with it. Contact names are matched separately with
 * trigram similarity, because "what did Sarah say about the deposit" carries
 * the person in the question and keyword search alone would miss every message
 * that never contains the word "Sarah".
 */
export async function askArchiveAction(question: string): Promise<AskResult> {
  await requireUser();
  if (!isAiEnabled()) return { ok: false, error: 'AI is not configured.' };

  const q = question.trim();
  if (q.length < 3) return { ok: false, error: 'Ask a longer question.' };

  // Conversations belonging to a person named in the question.
  // Compared word by word, not against the whole sentence: trigram similarity
  // is length-normalised, so `displayName % 'what did sarah say about the
  // deposit'` never clears the threshold and this path silently never fired.
  const words = Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[^a-z']+/i)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
    ),
  ).slice(0, 8);

  const namedContacts = words.length
    ? await db
        .select({ id: contacts.id, name: contacts.displayName })
        .from(contacts)
        .where(
          sql.join(
            words.map((w) => sql`${contacts.displayName} ilike ${'%' + w + '%'}`),
            sql` or `,
          ),
        )
        .limit(5)
    : [];

  // Parameterized rather than interpolated. These ids come from our own table,
  // but building SQL by string concatenation is a habit worth not having.
  const nameFilter = namedContacts.length
    ? sql`or ${inArray(
        conversations.contactId,
        namedContacts.map((c) => c.id),
      )}`
    : sql``;

  const rows = await db
    .select({
      conversationId: messages.conversationId,
      body: messages.body,
      createdAt: messages.createdAt,
      direction: messages.direction,
      title: conversations.title,
      isGroup: conversations.isGroup,
      chatGuid: conversations.providerChatGuid,
      contactName: contacts.displayName,
      rank: sql<number>`ts_rank(to_tsvector('english', coalesce(${messages.body}, '')), websearch_to_tsquery('english', ${q}))`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      sql`(coalesce(${messages.body}, '') <> '' and ${messages.authorType} <> 'system' and (
        to_tsvector('english', coalesce(${messages.body}, '')) @@ websearch_to_tsquery('english', ${q})
        ${nameFilter}
      ))`,
    )
    .orderBy(
      desc(
        sql`ts_rank(to_tsvector('english', coalesce(${messages.body}, '')), websearch_to_tsquery('english', ${q}))`,
      ),
      desc(messages.createdAt),
    )
    .limit(40);

  if (rows.length === 0) {
    return { ok: true, answer: "I couldn't find anything in your messages about that.", sources: [] };
  }

  const excerpts = rows.map((r) => ({
    conversationId: r.conversationId,
    conversationName: conversationName({
      contactName: r.contactName,
      title: r.title,
      isGroup: r.isGroup,
      chatGuid: r.chatGuid,
    }),
    at: r.createdAt.toISOString().slice(0, 10),
    direction: r.direction as 'inbound' | 'outbound',
    body: (r.body ?? '').slice(0, 600),
  }));

  const { answer, citedIndexes } = await answerFromArchive({ question: q, excerpts });

  // Only the excerpts the model actually cited, KEYED BY THE NUMBER IT USED.
  // Renumbering from 1 made every [n] in the answer point at the wrong row,
  // which is worse than showing no sources at all — the whole promise of this
  // feature is that you can check it.
  const sources: ArchiveSource[] = citedIndexes
    .map((n) => {
      const e = excerpts[n - 1];
      return e
        ? {
            index: n,
            conversationId: e.conversationId,
            conversationName: e.conversationName,
            at: e.at,
            snippet: e.body.slice(0, 160),
          }
        : null;
    })
    .filter((s): s is ArchiveSource => s !== null);

  return { ok: true, answer, sources };
}

/**
 * Continue what the user is typing. Returns '' when there is nothing worth
 * suggesting, which is the common case and must stay cheap for the caller.
 */
export async function completeMessageAction(input: {
  conversationId: string;
  prefix: string;
}): Promise<{ completion: string }> {
  await requireUser();
  if (!isAiEnabled()) return { completion: '' };

  const prefix = input.prefix;
  // Too little to go on, or already a finished thought.
  if (prefix.trim().length < 8) return { completion: '' };
  if (/[.!?]\s*$/.test(prefix)) return { completion: '' };

  const loaded = await loadTranscript(input.conversationId);
  if (!loaded) return { completion: '' };

  try {
    const completion = await completeMessage({
      contactName: loaded.contactName,
      messages: loaded.transcript,
      prefix,
    });
    return { completion };
  } catch {
    // A failed completion must never surface as an error: the user is typing.
    return { completion: '' };
  }
}
