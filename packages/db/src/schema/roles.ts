import { pgTable, text, jsonb, boolean } from 'drizzle-orm/pg-core';
import { genId, timestamps } from './_helpers.js';

/**
 * The permission catalog. Every workspace capability that is gated at all is
 * gated on exactly one of these keys; a role is just a named set of them.
 *
 * Kept in the db package (not the web app) because the worker also needs to
 * answer "who can administer the system" when it notifies about outages.
 */
export const PERMISSIONS = [
  {
    key: 'workspace.manage',
    label: 'Manage workspace',
    description: 'Workspace name, signatures, SLA defaults, tags, and macros.',
  },
  {
    key: 'inboxes.manage',
    label: 'Manage inboxes',
    description: 'Connect numbers, configure channels and the BlueBubbles bridge.',
  },
  {
    key: 'users.manage',
    label: 'Manage users',
    description: 'Add teammates, change which role each person has, deactivate accounts.',
  },
  {
    key: 'roles.manage',
    label: 'Manage roles',
    description: 'Create roles and choose which permissions each role grants.',
  },
  {
    key: 'automations.manage',
    label: 'Manage automations',
    description: 'Create and edit automation rules and business hours.',
  },
  {
    key: 'folders.manage_shared',
    label: 'Manage shared folders',
    description: 'Create, edit and delete the folders everyone sees.',
  },
  {
    key: 'system.admin',
    label: 'Admin panel access',
    description: 'The machine room: version, AI providers, runtime config, and service health.',
  },
  {
    key: 'system.impersonate',
    label: 'View as another user',
    description:
      'Open a read-only session as someone else to see exactly what they see. Every start and stop is recorded.',
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

/**
 * `'*'` in a role's permission list grants everything, including permissions
 * added in future versions — which is what makes the Owner role future-proof
 * without a data migration per release.
 */
export const WILDCARD_PERMISSION = '*';

/** Fixed ids for the three seeded roles, stable across installs. */
export const OWNER_ROLE_ID = 'role_owner';
export const ADMIN_ROLE_ID = 'role_admin';
export const AGENT_ROLE_ID = 'role_agent';

/** Does a permission list grant a capability? The one predicate everything gates on. */
export function roleGrants(
  permissions: readonly string[] | null | undefined,
  key: PermissionKey,
): boolean {
  if (!permissions?.length) return false;
  return permissions.includes(WILDCARD_PERMISSION) || permissions.includes(key);
}

/** True when the list grants at least one workspace-level capability. */
export function grantsAnything(permissions: readonly string[] | null | undefined): boolean {
  return Boolean(permissions?.length);
}

/**
 * A role: a named, customizable set of permissions. Users point at exactly one
 * role. The three seeded system roles (`isSystem`) cannot be deleted; Owner
 * additionally cannot be edited, so a workspace can never lock itself out.
 */
export const roles = pgTable('roles', {
  id: text('id').primaryKey().$defaultFn(genId('role')),
  name: text('name').notNull().unique(),
  description: text('description'),
  /** Permission keys from the catalog, or `['*']` for the Owner role. */
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps,
});
