'use server';

import { revalidatePath } from 'next/cache';
import { eq, sql } from '@comms/db';
import { macros, conversations, conversationTags, messages } from '@comms/db';
import { renderTemplate, firstNameOf, type TemplateContext } from '@comms/core';
import { db } from '@/server/db';
import { requireUser } from '@/lib/session';
import { getOrgSettings } from '@/server/settings';

export type MacroApplyResult =
  | { ok: true; body: string; appliedActions: string[] }
  | { ok: false; error: string };

/**
 * Apply a macro to a conversation: render its template variables against the
 * live conversation, run any attached actions (status / priority / assignee /
 * tags), and return the rendered text for the composer to insert.
 *
 * The actions half is what turns a macro from a snippet into a one-keystroke
 * workflow — "Refund approved" can also close the ticket and tag it.
 */
export async function applyMacro(input: {
  macroId: string;
  conversationId: string;
}): Promise<MacroApplyResult> {
  const user = await requireUser();

  const macro = await db.query.macros.findFirst({ where: eq(macros.id, input.macroId) });
  if (!macro) return { ok: false, error: 'Macro not found.' };

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
    with: {
      contact: { with: { identities: true } },
      inbox: { columns: { name: true } },
    },
  });
  if (!conv) return { ok: false, error: 'Conversation not found.' };

  const org = await getOrgSettings();
  const contactName = conv.contact?.displayName ?? null;
  const ctx: TemplateContext = {
    contact: {
      name: contactName,
      first_name: firstNameOf(contactName),
      company: conv.contact?.company ?? null,
      phone: conv.contact?.identities?.[0]?.value ?? null,
    },
    agent: {
      name: user.name ?? null,
      first_name: firstNameOf(user.name),
      email: user.email ?? null,
    },
    ticket: { number: conv.number, status: conv.status },
    inbox: { name: conv.inbox?.name ?? null },
    org: { name: org.orgName ?? null },
  };

  const body = renderTemplate(macro.body, ctx);

  // Apply attached actions.
  const applied: string[] = [];
  const patch: Partial<typeof conversations.$inferInsert> = {};
  const a = macro.actions ?? {};
  if (a.setStatus && a.setStatus !== conv.status) {
    patch.status = a.setStatus;
    if (a.setStatus === 'closed') patch.closedAt = new Date();
    if (a.setStatus !== 'open') patch.nextResponseDueAt = null;
    applied.push(`status → ${a.setStatus}`);
  }
  if (a.setPriority && a.setPriority !== conv.priority) {
    patch.priority = a.setPriority;
    applied.push(`priority → ${a.setPriority}`);
  }
  if (a.assignToUserId !== undefined && a.assignToUserId !== conv.assigneeId) {
    patch.assigneeId = a.assignToUserId;
    applied.push(a.assignToUserId ? 'assigned' : 'unassigned');
  }
  if (Object.keys(patch).length > 0) {
    await db.update(conversations).set(patch).where(eq(conversations.id, conv.id));
  }
  for (const tagId of a.addTagIds ?? []) {
    await db
      .insert(conversationTags)
      .values({ conversationId: conv.id, tagId })
      .onConflictDoNothing();
  }
  if ((a.addTagIds?.length ?? 0) > 0) applied.push('tagged');

  if (applied.length > 0) {
    await db.insert(messages).values({
      conversationId: conv.id,
      direction: 'outbound',
      authorType: 'system',
      authorUserId: user.id,
      body: `Macro "${macro.name}" applied — ${applied.join(', ')}`,
      status: 'sent',
      sentAt: new Date(),
    });
  }

  // Usage stats: reveals what the team actually says, and later feeds the AI
  // brand-voice examples.
  await db
    .update(macros)
    .set({ usageCount: sql`${macros.usageCount} + 1`, lastUsedAt: new Date() })
    .where(eq(macros.id, macro.id));

  revalidatePath(`/inbox/${conv.id}`);
  return { ok: true, body, appliedActions: applied };
}
