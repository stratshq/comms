'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { eq, WILDCARD_PERMISSION } from '@comms/db';
import { users, tags, macros, roles, AGENT_ROLE_ID } from '@comms/db';
import { db } from '@/server/db';
import { requirePermission } from '@/lib/session';
import { getOrgSettings, setSetting } from '@/server/settings';

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createTeammate(input: {
  name: string;
  email: string;
  password: string;
  roleId?: string;
}): Promise<ActionResult> {
  const caller = await requirePermission('users.manage');
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, error: 'Enter a valid email.' };
  if (input.password.length < 8) return { ok: false, error: 'Password must be 8+ characters.' };

  const roleId = input.roleId ?? AGENT_ROLE_ID;
  const role = await db.query.roles.findFirst({ where: eq(roles.id, roleId) });
  if (!role) return { ok: false, error: 'Pick a valid role.' };
  // Only an owner can create another owner — same rule as reassignment.
  if (
    role.permissions.includes(WILDCARD_PERMISSION) &&
    !caller.permissions.includes(WILDCARD_PERMISSION)
  ) {
    return { ok: false, error: 'Only an owner can grant the Owner role.' };
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) return { ok: false, error: 'A user with that email already exists.' };

  await db.insert(users).values({
    name: input.name.trim() || email,
    email,
    hashedPassword: await bcrypt.hash(input.password, 12),
    roleId,
    status: 'active',
    emailVerified: new Date(),
  });
  revalidatePath('/settings/team');
  return { ok: true };
}

export async function createTag(input: { name: string; color: string }): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Tag name is required.' };
  await db
    .insert(tags)
    .values({ name, color: input.color || '#71717a' })
    .onConflictDoNothing();
  revalidatePath('/settings/tags');
  return { ok: true };
}

export async function deleteTag(id: string): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  await db.delete(tags).where(eq(tags.id, id));
  revalidatePath('/settings/tags');
  return { ok: true };
}

export async function createMacro(input: {
  name: string;
  body: string;
  shortcut?: string;
}): Promise<ActionResult> {
  const admin = await requirePermission('workspace.manage');
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Macro name is required.' };
  await db.insert(macros).values({
    name,
    body: input.body,
    shortcut: input.shortcut?.trim() || null,
    createdByUserId: admin.id,
  });
  revalidatePath('/settings/macros');
  return { ok: true };
}

export async function deleteMacro(id: string): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  await db.delete(macros).where(eq(macros.id, id));
  revalidatePath('/settings/macros');
  return { ok: true };
}

export async function updateOrgName(orgName: string): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  const current = await getOrgSettings();
  await setSetting('org', { ...current, orgName: orgName.trim() || 'Comms' });
  revalidatePath('/settings/workspace');
  return { ok: true };
}

/**
 * Workspace-level switch for the whole signature mechanism. Off means no
 * signature is ever appended, regardless of what people have configured —
 * the one-stop opt-out for teams that find signatures noisy over iMessage.
 */
export async function updateSignatureSettings(input: { enabled: boolean }): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  await setSetting('signatures', { enabled: Boolean(input.enabled) });
  revalidatePath('/settings/workspace');
  return { ok: true };
}

export async function updateSlaSettings(input: {
  firstResponseMinutes?: number;
  nextResponseMinutes?: number;
}): Promise<ActionResult> {
  await requirePermission('workspace.manage');
  await setSetting('sla', {
    firstResponseMinutes: input.firstResponseMinutes && input.firstResponseMinutes > 0
      ? input.firstResponseMinutes
      : undefined,
    nextResponseMinutes: input.nextResponseMinutes && input.nextResponseMinutes > 0
      ? input.nextResponseMinutes
      : undefined,
  });
  revalidatePath('/settings/workspace');
  return { ok: true };
}
