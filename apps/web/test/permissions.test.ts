import { describe, it, expect } from 'vitest';
import {
  ALL_PERMISSION_KEYS,
  roleGrants,
  grantsAnything,
  OWNER_ROLE_ID,
  ADMIN_ROLE_ID,
} from '@comms/db';
import {
  normalizePermissions,
  checkRoleChange,
  checkRoleEdit,
} from '../src/lib/permissions';

const WILDCARD = ['*'];
const ADMIN = [...ALL_PERMISSION_KEYS];
const AGENT: string[] = [];

describe('roleGrants', () => {
  it('grants every catalog key to the wildcard', () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(roleGrants(WILDCARD, key)).toBe(true);
    }
  });

  it('grants exactly the listed keys otherwise', () => {
    expect(roleGrants(['users.manage'], 'users.manage')).toBe(true);
    expect(roleGrants(['users.manage'], 'roles.manage')).toBe(false);
  });

  it('grants nothing on an empty or missing list', () => {
    expect(roleGrants(AGENT, 'users.manage')).toBe(false);
    expect(roleGrants(null, 'users.manage')).toBe(false);
    expect(roleGrants(undefined, 'users.manage')).toBe(false);
  });
});

describe('grantsAnything', () => {
  it('is true for wildcard and any non-empty list, false for empty', () => {
    expect(grantsAnything(WILDCARD)).toBe(true);
    expect(grantsAnything(['automations.manage'])).toBe(true);
    expect(grantsAnything(AGENT)).toBe(false);
    expect(grantsAnything(null)).toBe(false);
  });
});

describe('normalizePermissions', () => {
  it('drops unknown keys and the wildcard, and dedupes', () => {
    const input = ['users.manage', 'users.manage', '*', 'made.up', 'roles.manage'];
    expect(normalizePermissions(input)).toEqual(['users.manage', 'roles.manage']);
  });

  it('accepts the full catalog unchanged', () => {
    expect(normalizePermissions(ALL_PERMISSION_KEYS)).toEqual(ALL_PERMISSION_KEYS);
  });
});

describe('checkRoleChange', () => {
  it('lets an admin move an agent between non-owner roles', () => {
    expect(
      checkRoleChange({
        callerPermissions: ADMIN,
        currentRolePermissions: AGENT,
        newRolePermissions: ['automations.manage'],
        otherActiveOwners: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('blocks a non-owner from granting an owner-level role', () => {
    const verdict = checkRoleChange({
      callerPermissions: ADMIN,
      currentRolePermissions: AGENT,
      newRolePermissions: WILDCARD,
      otherActiveOwners: 1,
    });
    expect(verdict.ok).toBe(false);
  });

  it('blocks a non-owner from demoting an owner', () => {
    const verdict = checkRoleChange({
      callerPermissions: ADMIN,
      currentRolePermissions: WILDCARD,
      newRolePermissions: AGENT,
      otherActiveOwners: 3,
    });
    expect(verdict.ok).toBe(false);
  });

  it('lets an owner demote another owner while one remains', () => {
    expect(
      checkRoleChange({
        callerPermissions: WILDCARD,
        currentRolePermissions: WILDCARD,
        newRolePermissions: ADMIN,
        otherActiveOwners: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('never allows demoting the last active owner — even by themselves', () => {
    const verdict = checkRoleChange({
      callerPermissions: WILDCARD,
      currentRolePermissions: WILDCARD,
      newRolePermissions: ADMIN,
      otherActiveOwners: 0,
    });
    expect(verdict.ok).toBe(false);
  });

  it('owner-to-owner moves need no remaining-owner check', () => {
    expect(
      checkRoleChange({
        callerPermissions: WILDCARD,
        currentRolePermissions: WILDCARD,
        newRolePermissions: WILDCARD,
        otherActiveOwners: 0,
      }),
    ).toEqual({ ok: true });
  });
});

describe('checkRoleEdit', () => {
  it('locks the Owner role completely', () => {
    expect(checkRoleEdit({ id: OWNER_ROLE_ID, isSystem: true }, {}).ok).toBe(false);
  });

  it('allows re-permissioning a system role but not renaming or deleting it', () => {
    const admin = { id: ADMIN_ROLE_ID, isSystem: true };
    expect(checkRoleEdit(admin, {})).toEqual({ ok: true });
    expect(checkRoleEdit(admin, { rename: true }).ok).toBe(false);
    expect(checkRoleEdit(admin, { delete: true }).ok).toBe(false);
  });

  it('blocks deleting a custom role that still has members', () => {
    const custom = { id: 'role_x', isSystem: false };
    expect(checkRoleEdit(custom, { delete: true, memberCount: 2 }).ok).toBe(false);
    expect(checkRoleEdit(custom, { delete: true, memberCount: 0 })).toEqual({ ok: true });
  });

  it('allows renaming custom roles', () => {
    expect(checkRoleEdit({ id: 'role_x', isSystem: false }, { rename: true })).toEqual({
      ok: true,
    });
  });
});
