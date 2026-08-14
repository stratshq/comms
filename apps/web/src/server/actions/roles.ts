'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, ne, sql } from '@comms/db';
import { roles, users, WILDCARD_PERMISSION } from '@comms/db';
import { db } from '@/server/db';
import { requireAnyPermission, requirePermission } from '@/lib/session';
import { checkRoleChange, checkRoleEdit, normalizePermissions } from '@/lib/permissions';

export type RoleResult = { ok: true } | { ok: false; error: string };

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  /** Users currently on this role. */
  memberCount: number;
}

/**
 * Roles for the settings pages. Needed both by the role editor
 * (`roles.manage`) and by the People page's role picker (`users.manage`).
 */
export async function listRoles(): Promise<RoleRow[]> {
  await requireAnyPermission(['roles.manage', 'users.manage']);

  const [rows, counts] = await Promise.all([
    db.query.roles.findMany({ orderBy: [asc(roles.createdAt), asc(roles.name)] }),
    db
      .select({ roleId: users.roleId, n: sql<number>`count(*)` })
      .from(users)
      .groupBy(users.roleId),
  ]);
  const countBy = new Map(counts.map((c) => [c.roleId, Number(c.n)]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    isSystem: r.isSystem,
    memberCount: countBy.get(r.id) ?? 0,
  }));
}

export async function createRole(input: {
  name: string;
  description?: string;
  permissions: string[];
}): Promise<RoleResult> {
  await requirePermission('roles.manage');
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Give the role a name.' };
  if (name.length > 60) return { ok: false, error: 'Name must be 60 characters or fewer.' };

  const existing = await db.query.roles.findFirst({ where: eq(roles.name, name) });
  if (existing) return { ok: false, error: 'A role with that name already exists.' };

  await db.insert(roles).values({
    name,
    description: input.description?.trim() || null,
    // Unknown keys and the wildcard are silently dropped — the catalog is the
    // only source of grantable permissions.
    permissions: normalizePermissions(input.permissions),
  });
  revalidatePath('/settings/roles');
  return { ok: true };
}

export async function updateRole(input: {
  id: string;
  name?: string;
  description?: string | null;
  permissions?: string[];
}): Promise<RoleResult> {
  await requirePermission('roles.manage');
  const role = await db.query.roles.findFirst({ where: eq(roles.id, input.id) });
  if (!role) return { ok: false, error: 'Role not found.' };

  const renaming = input.name !== undefined && input.name.trim() !== role.name;
  const verdict = checkRoleEdit(role, { rename: renaming });
  if (!verdict.ok) return verdict;

  const patch: Partial<typeof roles.$inferInsert> = {};
  if (renaming) {
    const name = input.name!.trim();
    if (!name) return { ok: false, error: 'Give the role a name.' };
    const clash = await db.query.roles.findFirst({
      where: and(eq(roles.name, name), ne(roles.id, role.id)),
    });
    if (clash) return { ok: false, error: 'A role with that name already exists.' };
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.permissions !== undefined) patch.permissions = normalizePermissions(input.permissions);
  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(roles).set(patch).where(eq(roles.id, role.id));
  revalidatePath('/settings/roles');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteRole(id: string): Promise<RoleResult> {
  await requirePermission('roles.manage');
  const role = await db.query.roles.findFirst({ where: eq(roles.id, id) });
  if (!role) return { ok: false, error: 'Role not found.' };

  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.roleId, id));
  const verdict = checkRoleEdit(role, { delete: true, memberCount: Number(row?.n ?? 0) });
  if (!verdict.ok) return verdict;

  await db.delete(roles).where(eq(roles.id, id));
  revalidatePath('/settings/roles');
  return { ok: true };
}

/**
 * Move a user onto a different role. Guarded beyond `users.manage`: only an
 * owner can grant or revoke owner-level roles, and the last active owner can
 * never be demoted — see `checkRoleChange` for the reasoning.
 */
export async function setUserRole(userId: string, roleId: string): Promise<RoleResult> {
  const caller = await requirePermission('users.manage');

  const [target, newRole] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, roleId: true },
      with: { role: { columns: { permissions: true } } },
    }),
    db.query.roles.findFirst({ where: eq(roles.id, roleId) }),
  ]);
  if (!target) return { ok: false, error: 'User not found.' };
  if (!newRole) return { ok: false, error: 'Role not found.' };
  if (target.roleId === roleId) return { ok: true };

  // Active users other than the target whose role still grants everything.
  const [ownerRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(
      and(
        eq(users.status, 'active'),
        ne(users.id, target.id),
        sql`${roles.permissions} ? ${WILDCARD_PERMISSION}`,
      ),
    );

  const verdict = checkRoleChange({
    callerPermissions: caller.permissions,
    currentRolePermissions: target.role?.permissions ?? [],
    newRolePermissions: newRole.permissions,
    otherActiveOwners: Number(ownerRow?.n ?? 0),
  });
  if (!verdict.ok) return verdict;

  await db.update(users).set({ roleId }).where(eq(users.id, userId));
  revalidatePath('/settings/team');
  revalidatePath('/settings/roles');
  return { ok: true };
}

/** Roles the caller is allowed to hand out, for the add-teammate and People pickers. */
export async function listAssignableRoles(): Promise<{ id: string; name: string }[]> {
  const caller = await requireAnyPermission(['roles.manage', 'users.manage']);
  const callerIsOwner = caller.permissions.includes(WILDCARD_PERMISSION);
  const rows = await db.query.roles.findMany({ orderBy: [asc(roles.createdAt), asc(roles.name)] });
  return rows
    // Owner-level roles are only offered to owners — checkRoleChange would
    // reject the assignment anyway; better not to dangle it.
    .filter((r) => callerIsOwner || !r.permissions.includes(WILDCARD_PERMISSION))
    .map((r) => ({ id: r.id, name: r.name }));
}
