'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull, or, sql } from '@comms/db';
import {
  savedViews,
  tags,
  tagSuggestions,
  conversations,
  conversationTags,
  type ViewFilters,
} from '@comms/db';
import { db } from '@/server/db';
import { requireUser, requirePermission, requireWriter } from '@/lib/session';

export type ViewResult = { ok: true } | { ok: false; error: string };

// ---- Saved views ------------------------------------------------------------

export async function createSavedView(input: {
  name: string;
  icon?: string;
  filters: ViewFilters;
  isShared?: boolean;
  /** 'sidebar' is a nav row; 'section' is a header inside the inbox list. */
  display?: 'sidebar' | 'section';
}): Promise<ViewResult> {
  const user = await requireWriter();
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Give the folder a name.' };

  await db.insert(savedViews).values({
    name,
    icon: input.icon ?? 'Filter',
    filters: input.filters,
    display: input.display ?? 'sidebar',
    isShared: Boolean(input.isShared),
    ownerUserId: user.id,
  });
  revalidatePath('/inbox');
  revalidatePath('/settings/views');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * Move a folder between the sidebar and the inbox list, or rename it. The
 * same object either way — "split inbox" is just `display: 'section'`.
 */
export async function updateSavedView(input: {
  id: string;
  name?: string;
  icon?: string;
  display?: 'sidebar' | 'section';
  filters?: ViewFilters;
  isShared?: boolean;
  sortOrder?: number;
}): Promise<ViewResult> {
  const user = await requireWriter();
  const view = await db.query.savedViews.findFirst({ where: eq(savedViews.id, input.id) });
  if (!view) return { ok: false, error: 'Folder not found.' };
  if (view.ownerUserId !== user.id) await requirePermission('folders.manage_shared');

  const patch: Partial<typeof savedViews.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, error: 'Give the folder a name.' };
    patch.name = name;
  }
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.display !== undefined) patch.display = input.display;
  if (input.filters !== undefined) patch.filters = input.filters;
  if (input.isShared !== undefined) patch.isShared = input.isShared;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(savedViews).set(patch).where(eq(savedViews.id, input.id));
  revalidatePath('/inbox');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** The split-inbox axes an admin can switch on and off from Workspace settings. */
const SPLIT_KINDS = ['otp', 'automated', 'unknown'] as const;
type SplitKind = (typeof SPLIT_KINDS)[number];

const SPLIT_DEFAULTS: Record<SplitKind, { name: string; icon: string }> = {
  otp: { name: 'Verification codes', icon: 'KeyRound' },
  automated: { name: 'Automated', icon: 'Bot' },
  unknown: { name: 'Unknown numbers', icon: 'UserRound' },
};

/** Which split-inbox folders currently exist (shared, filtered on that kind). */
export async function getSplitInboxState(): Promise<Record<SplitKind, boolean>> {
  await requireUser();
  const shared = await db.query.savedViews.findMany({ where: eq(savedViews.isShared, true) });
  const state = { otp: false, automated: false, unknown: false };
  for (const v of shared) {
    const kind = v.filters?.kind as SplitKind | undefined;
    if (kind && kind in state) state[kind] = true;
  }
  return state;
}

/**
 * Turn a split-inbox section on or off. On creates the shared folder, off
 * deletes it — the switch and the folder are the same fact, so the toggle
 * can never disagree with what the inbox actually shows.
 */
export async function setSplitInboxFolder(kind: string, enabled: boolean): Promise<ViewResult> {
  await requirePermission('folders.manage_shared');
  if (!(SPLIT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: 'Unknown split-inbox section.' };
  }
  const k = kind as SplitKind;

  const shared = await db.query.savedViews.findMany({ where: eq(savedViews.isShared, true) });
  const existing = shared.filter((v) => v.filters?.kind === k);

  if (enabled && existing.length === 0) {
    await db.insert(savedViews).values({
      name: SPLIT_DEFAULTS[k].name,
      icon: SPLIT_DEFAULTS[k].icon,
      display: 'section',
      isShared: true,
      ownerUserId: null,
      filters: { kind: k, status: 'active' },
    });
  } else if (!enabled) {
    for (const v of existing) {
      await db.delete(savedViews).where(eq(savedViews.id, v.id));
    }
  }

  revalidatePath('/inbox');
  revalidatePath('/settings/workspace');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteSavedView(id: string): Promise<ViewResult> {
  const user = await requireWriter();
  const view = await db.query.savedViews.findFirst({ where: eq(savedViews.id, id) });
  if (!view) return { ok: false, error: 'View not found.' };
  // Owners can delete their own; shared views need admin.
  if (view.ownerUserId !== user.id) await requirePermission('folders.manage_shared');
  await db.delete(savedViews).where(eq(savedViews.id, id));
  revalidatePath('/inbox');
  revalidatePath('/settings/views');
  return { ok: true };
}

export async function renameSavedView(id: string, name: string): Promise<ViewResult> {
  const user = await requireWriter();
  const view = await db.query.savedViews.findFirst({ where: eq(savedViews.id, id) });
  if (!view) return { ok: false, error: 'View not found.' };
  if (view.ownerUserId !== user.id) await requirePermission('folders.manage_shared');
  await db.update(savedViews).set({ name: name.trim() }).where(eq(savedViews.id, id));
  revalidatePath('/inbox');
  return { ok: true };
}

/**
 * Create a tag and apply it to a conversation in one move — the panel's
 * "No tags yet" dead-end, fixed. Permission-gated because the tag list is
 * curated (that's the whole point of the AI suggestion queue); reuses an
 * existing tag of the same name instead of erroring.
 */
export async function createAndApplyTag(input: {
  conversationId: string;
  name: string;
  color?: string;
}): Promise<{ ok: true; tagId: string } | { ok: false; error: string }> {
  // Tags are workspace vocabulary — same grant as the tags settings page.
  await requirePermission('workspace.manage');
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Tag name is required.' };
  if (name.length > 40) return { ok: false, error: 'Tag name must be 40 characters or fewer.' };

  const [created] = await db
    .insert(tags)
    .values({ name, color: input.color || '#71717a' })
    .onConflictDoNothing()
    .returning({ id: tags.id });
  const tagId = created?.id ?? (await db.query.tags.findFirst({ where: eq(tags.name, name) }))?.id;
  if (!tagId) return { ok: false, error: 'Could not create the tag.' };

  await db
    .insert(conversationTags)
    .values({ conversationId: input.conversationId, tagId })
    .onConflictDoNothing();

  revalidatePath(`/inbox/${input.conversationId}`);
  revalidatePath('/settings/tags');
  return { ok: true, tagId };
}

// ---- Tag hygiene ------------------------------------------------------------

/**
 * Merge `sourceId` into `targetId`: move every conversation tagged with the
 * source onto the target (skipping ones already tagged), then delete the
 * source. Fixes the inevitable "billing" / "Billing" duplication.
 */
export async function mergeTags(sourceId: string, targetId: string): Promise<ViewResult> {
  await requirePermission('folders.manage_shared');
  if (sourceId === targetId) return { ok: false, error: 'Pick two different tags.' };

  const rows = await db
    .select({ conversationId: conversationTags.conversationId })
    .from(conversationTags)
    .where(eq(conversationTags.tagId, sourceId));

  for (const r of rows) {
    await db
      .insert(conversationTags)
      .values({ conversationId: r.conversationId, tagId: targetId })
      .onConflictDoNothing();
  }
  await db.delete(tags).where(eq(tags.id, sourceId)); // cascades conversation_tags
  revalidatePath('/settings/tags');
  revalidatePath('/inbox');
  return { ok: true };
}

/** Tag list with usage counts, so unused/duplicate tags are visible. */
export async function listTagsWithUsage() {
  await requireUser();
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      usageCount: sql<number>`count(${conversationTags.conversationId})`,
    })
    .from(tags)
    .leftJoin(conversationTags, eq(conversationTags.tagId, tags.id))
    .groupBy(tags.id, tags.name, tags.color)
    .orderBy(sql`count(${conversationTags.conversationId}) desc`);
}

// ---- AI tag suggestions -----------------------------------------------------

export async function listTagSuggestions() {
  await requireUser();
  return db.query.tagSuggestions.findMany({
    where: isNull(tagSuggestions.dismissedAt),
    orderBy: (t, { desc }) => [desc(t.count)],
    limit: 20,
  });
}

/**
 * Approve a suggested tag: create the real tag, then retroactively apply it to
 * every conversation whose AI triage already wanted it. Approving once makes it
 * work forever after — that's the point of the queue.
 */
export async function approveTagSuggestion(
  id: string,
  color = '#71717a',
): Promise<ViewResult> {
  await requirePermission('folders.manage_shared');
  const suggestion = await db.query.tagSuggestions.findFirst({
    where: eq(tagSuggestions.id, id),
  });
  if (!suggestion) return { ok: false, error: 'Suggestion not found.' };

  const [tag] = await db
    .insert(tags)
    .values({ name: suggestion.name, color })
    .onConflictDoNothing()
    .returning({ id: tags.id });

  const tagId =
    tag?.id ?? (await db.query.tags.findFirst({ where: eq(tags.name, suggestion.name) }))?.id;

  if (tagId) {
    // Backfill: any conversation whose stored AI triage suggested this name.
    const candidates = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(sql`${conversations.metadata}->'ai'->'suggestedTags' ? ${suggestion.name}`);
    for (const c of candidates) {
      await db
        .insert(conversationTags)
        .values({ conversationId: c.id, tagId })
        .onConflictDoNothing();
    }
  }

  await db.delete(tagSuggestions).where(eq(tagSuggestions.id, id));
  revalidatePath('/settings/tags');
  revalidatePath('/inbox');
  return { ok: true };
}

export async function dismissTagSuggestion(id: string): Promise<ViewResult> {
  await requirePermission('folders.manage_shared');
  await db
    .update(tagSuggestions)
    .set({ dismissedAt: new Date() })
    .where(eq(tagSuggestions.id, id));
  revalidatePath('/settings/tags');
  return { ok: true };
}
