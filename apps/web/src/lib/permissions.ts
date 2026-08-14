import {
  ALL_PERMISSION_KEYS,
  WILDCARD_PERMISSION,
  OWNER_ROLE_ID,
  type PermissionKey,
} from '@comms/db';

/**
 * Pure rules for who may hand out which role. Kept free of the database and
 * the session so they can be unit-tested — the server actions supply the
 * facts, these functions supply the verdict.
 */

/** Keep only real catalog keys, deduped. The wildcard is never accepted from input. */
export function normalizePermissions(input: readonly string[]): PermissionKey[] {
  const allowed = new Set<string>(ALL_PERMISSION_KEYS);
  return [...new Set(input)].filter((p): p is PermissionKey => allowed.has(p));
}

const isWildcard = (permissions: readonly string[]) => permissions.includes(WILDCARD_PERMISSION);

export type RoleChangeVerdict = { ok: true } | { ok: false; error: string };

/**
 * May the caller move a user onto a new role?
 *
 * Two invariants beyond the `users.manage` permission the caller already
 * proved:
 * 1. Owner-level (wildcard) roles are only granted or revoked by someone who
 *    holds the wildcard — otherwise an admin could mint themselves an owner.
 * 2. The workspace must always keep at least one active owner, or it locks
 *    itself out of role management permanently.
 */
export function checkRoleChange(input: {
  callerPermissions: readonly string[];
  /** Permissions of the role the target user has right now. */
  currentRolePermissions: readonly string[];
  /** Permissions of the role being assigned. */
  newRolePermissions: readonly string[];
  /** Active users OTHER than the target whose role grants the wildcard. */
  otherActiveOwners: number;
}): RoleChangeVerdict {
  const grantingOwner = isWildcard(input.newRolePermissions);
  const revokingOwner = isWildcard(input.currentRolePermissions) && !grantingOwner;

  if ((grantingOwner || revokingOwner) && !isWildcard(input.callerPermissions)) {
    return { ok: false, error: 'Only an owner can grant or revoke the Owner role.' };
  }
  if (revokingOwner && input.otherActiveOwners === 0) {
    return { ok: false, error: 'The workspace needs at least one owner.' };
  }
  return { ok: true };
}

export type RoleEditVerdict = { ok: true } | { ok: false; error: string };

/** May a role's definition be edited or deleted at all? */
export function checkRoleEdit(
  role: { id: string; isSystem: boolean },
  edit: { rename?: boolean; delete?: boolean; memberCount?: number },
): RoleEditVerdict {
  if (role.id === OWNER_ROLE_ID) {
    return { ok: false, error: 'The Owner role cannot be changed.' };
  }
  if (role.isSystem && (edit.rename || edit.delete)) {
    return { ok: false, error: 'Built-in roles can be re-permissioned but not renamed or deleted.' };
  }
  if (edit.delete && (edit.memberCount ?? 0) > 0) {
    return { ok: false, error: 'Move its members to another role first.' };
  }
  return { ok: true };
}
