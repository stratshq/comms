import type { Job } from 'bullmq';
import { type AiJob, publishEvent, logger } from '@comms/core';
import {
  isAiConfigured,
  triageConversation,
  summarizeConversation,
  suggestReply,
  assignBundles,
  type BundleCandidate,
  type TranscriptMessage,
} from '@comms/ai';
import { getDb, eq, and, asc, desc, inArray, isNull, sql } from '@comms/db';
import {
  conversations,
  messages,
  conversationTags,
  tagSuggestions,
  bundles,
  appSettings,
} from '@comms/db';

const log = logger.child({ module: 'ai' });

/** Load the recent transcript for a conversation in the AI package's shape. */
async function loadTranscript(conversationId: string): Promise<{
  transcript: TranscriptMessage[];
  contactName: string | null;
}> {
  const db = getDb();
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: { contact: { columns: { displayName: true } } },
  });

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

  return { transcript, contactName: conv?.contact?.displayName ?? null };
}

/** Merge a patch into conversations.metadata.ai without clobbering siblings. */
async function mergeAiMetadata(conversationId: string, patch: Record<string, unknown>) {
  const db = getDb();
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { metadata: true, inboxId: true },
  });
  if (!conv) return;
  const meta = (conv.metadata ?? {}) as Record<string, unknown>;
  const ai = (meta.ai ?? {}) as Record<string, unknown>;
  await db
    .update(conversations)
    .set({ metadata: { ...meta, ai: { ...ai, ...patch, at: new Date().toISOString() } } })
    .where(eq(conversations.id, conversationId));
  await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
}

/**
 * Pre-compute the catch-up summary and next draft reply so both are waiting
 * before an agent opens the conversation — the difference between "click and
 * wait" and Tab-to-accept. Skipped when the last message is already ours.
 */
async function precompute(conversationId: string): Promise<void> {
  const db = getDb();

  const [latest] = await db
    .select({ direction: messages.direction })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!latest || latest.direction === 'outbound') return;

  const { transcript, contactName } = await loadTranscript(conversationId);
  if (transcript.length === 0) return;

  // Brand voice: recent real agent replies, so drafts sound like the team.
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

  const [summary, draft] = await Promise.all([
    summarizeConversation({ contactName, messages: transcript }).catch((err) => {
      log.warn({ conversationId, err: (err as Error).message }, 'summary precompute failed');
      return null;
    }),
    suggestReply({ contactName, messages: transcript, brandVoiceExamples }).catch((err) => {
      log.warn({ conversationId, err: (err as Error).message }, 'draft precompute failed');
      return null;
    }),
  ]);

  const patch: Record<string, unknown> = {};
  if (summary) patch.summary = summary;
  if (draft) patch.draft = draft;
  if (Object.keys(patch).length === 0) return;

  await mergeAiMetadata(conversationId, patch);
  log.info({ conversationId, summary: Boolean(summary), draft: Boolean(draft) }, 'ai precomputed');
}

async function triage(conversationId: string): Promise<void> {
  const db = getDb();
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) return;

  const { transcript, contactName } = await loadTranscript(conversationId);
  if (transcript.length === 0) return;

  let result;
  try {
    result = await triageConversation({ contactName, messages: transcript });
  } catch (err) {
    log.warn({ conversationId, err: (err as Error).message }, 'triage failed');
    return;
  }

  // Priority only when it hasn't been set manually (still default 'normal').
  if (conv.priority === 'normal' && result.priority !== 'normal') {
    await db
      .update(conversations)
      .set({ priority: result.priority })
      .where(eq(conversations.id, conv.id));
  }

  await mergeAiMetadata(conversationId, {
    summary: result.summary,
    topic: result.topic,
    sentiment: result.sentiment,
    suggestedTags: result.suggestedTags,
  });

  // Apply suggested tags that already exist; queue the rest for admin approval
  // instead of silently dropping them. Tags are never auto-created.
  if (result.suggestedTags.length) {
    const allTags = await db.query.tags.findMany();
    const byName = new Map(allTags.map((t) => [t.name.toLowerCase(), t.id]));
    for (const rawName of result.suggestedTags) {
      const name = rawName.toLowerCase().trim();
      if (!name) continue;
      const tagId = byName.get(name);
      if (tagId) {
        await db
          .insert(conversationTags)
          .values({ conversationId: conv.id, tagId })
          .onConflictDoNothing();
      } else {
        await db
          .insert(tagSuggestions)
          .values({ name, count: 1 })
          .onConflictDoUpdate({
            target: tagSuggestions.name,
            set: { count: sql`${tagSuggestions.count} + 1` },
          });
      }
    }
  }
}

/**
 * Bundle sweep: hand the model every active, un-bundled conversation and let
 * it group the ones that belong together. Only unassigned threads are
 * offered, so a manual "remove from bundle" or a dissolve sticks until the
 * thread itself changes; dissolved bundle names are passed as forbidden.
 */
async function bundleSweep(): Promise<void> {
  const db = getDb();

  const rows = await db.query.conversations.findMany({
    where: and(
      inArray(conversations.status, ['open', 'pending']),
      isNull(conversations.bundleId),
    ),
    orderBy: [desc(conversations.lastMessageAt)],
    limit: 120,
    columns: { id: true, title: true, lastMessagePreview: true, metadata: true },
    with: { contact: { columns: { displayName: true } } },
  });
  if (rows.length < 3) return; // nothing worth grouping

  const existing = await db.query.bundles.findMany();
  const dismissedRow = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'bundles_dismissed'),
  });
  const forbidden = Array.isArray(dismissedRow?.value) ? (dismissedRow.value as string[]) : [];

  const candidates: BundleCandidate[] = rows.map((r) => ({
    conversationId: r.id,
    name: r.contact?.displayName ?? r.title ?? 'Unknown',
    topic: ((r.metadata as { ai?: { topic?: string } } | null)?.ai?.topic ?? null) || null,
    preview: r.lastMessagePreview,
  }));

  let assignments;
  try {
    assignments = await assignBundles({
      candidates,
      existingBundles: existing.map((b) => b.name),
      forbiddenNames: forbidden,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'bundle sweep failed');
    return;
  }

  const byName = new Map(existing.map((b) => [b.name.toLowerCase(), b.id]));
  let changed = 0;

  for (const a of assignments) {
    if (!a.bundle) continue;
    let bundleId = byName.get(a.bundle.toLowerCase());
    if (!bundleId) {
      const [created] = await db
        .insert(bundles)
        .values({ name: a.bundle })
        .onConflictDoUpdate({ target: bundles.name, set: { updatedAt: new Date() } })
        .returning({ id: bundles.id });
      if (!created) continue;
      bundleId = created.id;
      byName.set(a.bundle.toLowerCase(), bundleId);
    }
    await db
      .update(conversations)
      // Guard on "still unassigned": a human filing the thread mid-sweep wins.
      .set({ bundleId })
      .where(and(eq(conversations.id, a.conversationId), isNull(conversations.bundleId)));
    changed += 1;
  }

  // Bundles whose last member left dissolve on their own — an empty group
  // header in the list is clutter with a name.
  await db.execute(sql`
    delete from ${bundles} b
    where not exists (select 1 from ${conversations} c where c.bundle_id = b.id)
  `);

  if (changed > 0) {
    log.info({ assigned: changed }, 'bundle sweep applied');
    // One coarse refresh signal — per-conversation events would stampede SSE.
    const [first] = rows;
    if (first) {
      const conv = await db.query.conversations.findFirst({
        where: eq(conversations.id, first.id),
        columns: { id: true, inboxId: true },
      });
      if (conv) {
        await publishEvent({
          type: 'conversation.updated',
          conversationId: conv.id,
          inboxId: conv.inboxId,
        });
      }
    }
  }
}

export async function processAiJob(job: Job<AiJob>): Promise<void> {
  if (!(await isAiConfigured())) return;
  switch (job.data.type) {
    case 'triage':
      return triage(job.data.conversationId);
    case 'precompute':
      return precompute(job.data.conversationId);
    case 'bundle':
      return bundleSweep();
  }
}
