import 'server-only';
import { redirect } from 'next/navigation';
import { eq, users, roleGrants, grantsAnything, type PermissionKey } from '@comms/db';
import { auth } from '@/auth';
import { db } from '@/server/db';

export async function getCurrentUser() {
  const session = await auth();
  return session?.user ?? null;
}

/** Require an authenticated user or redirect to login. */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * The signed-in user's current database row, with their role's permissions
 * resolved. The JWT carries only identity — authorization always reads the
 * database, so a role edit or reassignment applies on the next request rather
 * than at the next sign-in.
 */
export async function getCurrentDbUser() {
  const session = await getCurrentUser();
  if (!session?.id) return null;
  const row = await db.query.users.findFirst({
    where: eq(users.id, session.id),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      status: true,
      preferences: true,
      hashedPassword: true,
    },
    with: { role: { columns: { id: true, name: true, permissions: true, isSystem: true } } },
  });
  if (!row) return null;
  // Never hand a password hash to a caller; presence is all any of them need.
  const { hashedPassword, role, ...rest } = row;
  return {
    ...rest,
    hasPassword: Boolean(hashedPassword),
    roleName: role?.name ?? 'Agent',
    permissions: role?.permissions ?? [],
  };
}

export type CurrentDbUser = NonNullable<Awaited<ReturnType<typeof getCurrentDbUser>>>;

/** Does this user's role grant a capability? */
export function can(
  user: { permissions: readonly string[] },
  permission: PermissionKey,
): boolean {
  return roleGrants(user.permissions, permission);
}

/** True when the role grants at least one workspace-level capability. */
export function isElevated(user: { permissions: readonly string[] }): boolean {
  return grantsAnything(user.permissions);
}

/** Same as `getCurrentDbUser`, but bounces to login when there is no row. */
export async function requireDbUser(): Promise<CurrentDbUser> {
  const user = await getCurrentDbUser();
  if (!user) redirect('/login');
  return user;
}

/** Require a specific permission or throw. Use in server actions. */
export async function requirePermission(permission: PermissionKey): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!can(user, permission)) {
    throw new Error(`Forbidden: the "${permission}" permission is required`);
  }
  return user;
}

/** Require any of the listed permissions or throw. */
export async function requireAnyPermission(
  permissions: PermissionKey[],
): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!permissions.some((p) => can(user, p))) {
    throw new Error('Forbidden: insufficient permissions');
  }
  return user;
}

/**
 * Page-level guard. Unlike `requirePermission` this redirects rather than
 * throwing — someone who follows a stale admin link should land on their own
 * settings, not on an error page.
 */
export async function requirePermissionPage(permission: PermissionKey): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!can(user, permission)) redirect('/settings/profile');
  return user;
}

/** Page guard for the admin settings shell: any workspace permission at all. */
export async function requireElevatedPage(): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!isElevated(user)) redirect('/settings/profile');
  return user;
}
