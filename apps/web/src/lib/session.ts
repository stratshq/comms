import 'server-only';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { eq, users, roleGrants, grantsAnything, type PermissionKey } from '@comms/db';
import { loadConfig } from '@comms/core';
import { auth } from '@/auth';
import { db } from '@/server/db';
import { IMPERSONATION_COOKIE, decodeTicket } from '@/lib/impersonation';

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

const USER_COLUMNS = {
  id: true,
  name: true,
  email: true,
  image: true,
  roleId: true,
  status: true,
  preferences: true,
  hashedPassword: true,
} as const;

async function loadUser(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
    columns: USER_COLUMNS,
    with: { role: { columns: { id: true, name: true, permissions: true, isSystem: true } } },
  });
}

/**
 * The effective user for this request, with their role's permissions resolved.
 *
 * The JWT carries only identity — authorization always reads the database, so
 * a role edit or reassignment applies on the next request rather than at the
 * next sign-in.
 *
 * When a valid view-as ticket is present this returns the TARGET user, so
 * every page and query renders exactly what that person would see, with
 * `impersonatedBy` naming the real actor. The ticket is only honoured when its
 * actor still matches the live session, which is what makes signing out (or
 * signing in as someone else) end impersonation on its own.
 */
export async function getCurrentDbUser() {
  const session = await getCurrentUser();
  if (!session?.id) return null;

  const actor = await loadUser(session.id);
  if (!actor) return null;

  const shape = (
    row: NonNullable<Awaited<ReturnType<typeof loadUser>>>,
    impersonatedBy: { id: string; name: string | null; email: string } | null,
  ) => {
    // Never hand a password hash to a caller; presence is all any of them need.
    const { hashedPassword, role, ...rest } = row;
    return {
      ...rest,
      hasPassword: Boolean(hashedPassword),
      roleName: role?.name ?? 'Agent',
      permissions: (role?.permissions ?? []) as string[],
      impersonatedBy,
    };
  };

  const jar = await cookies();
  const ticket = decodeTicket(jar.get(IMPERSONATION_COOKIE)?.value, loadConfig().appSecret);
  // The ticket is bound to the session that minted it.
  if (!ticket || ticket.actorId !== actor.id) return shape(actor, null);

  const target = await loadUser(ticket.targetId);
  // A target that vanished or was disabled mid-session drops you back to
  // yourself rather than into a broken half-state.
  if (!target || target.status !== 'active') return shape(actor, null);

  return shape(target, { id: actor.id, name: actor.name, email: actor.email });
}

export type CurrentDbUser = NonNullable<Awaited<ReturnType<typeof getCurrentDbUser>>>;

/** Does this user's role grant a capability? */
export function can(user: { permissions: readonly string[] }, permission: PermissionKey): boolean {
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

/**
 * Thrown by every write guard while a view-as session is active. Viewing as
 * someone is for seeing what they see; acting as them would put words in their
 * mouth and their name on the audit trail.
 */
const READ_ONLY_MESSAGE =
  'You are viewing as another user. Stop viewing to make changes.';

function assertWritable(user: CurrentDbUser) {
  if (user.impersonatedBy) throw new Error(READ_ONLY_MESSAGE);
}

/**
 * Guard for any server action that CHANGES something.
 *
 * Writes are blocked by default during a view-as session, and the few
 * read-only actions that need a permission opt out explicitly via
 * `requirePermissionForRead`. Defaulting to "blocked" means a new action added
 * later is safe until someone deliberately says otherwise.
 */
export async function requireWriter(): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  assertWritable(user);
  return user;
}

/** Require a specific permission for a MUTATING action. */
export async function requirePermission(permission: PermissionKey): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!can(user, permission)) {
    throw new Error(`Forbidden: the "${permission}" permission is required`);
  }
  assertWritable(user);
  return user;
}

/** Permission check for a READ-ONLY action — allowed while viewing as someone. */
export async function requirePermissionForRead(
  permission: PermissionKey,
): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!can(user, permission)) {
    throw new Error(`Forbidden: the "${permission}" permission is required`);
  }
  return user;
}

/** Require any of the listed permissions (read-only). */
export async function requireAnyPermission(permissions: PermissionKey[]): Promise<CurrentDbUser> {
  const user = await requireDbUser();
  if (!permissions.some((p) => can(user, p))) {
    throw new Error('Forbidden: insufficient permissions');
  }
  return user;
}

/**
 * The REAL signed-in user, ignoring any view-as ticket. Only impersonation's
 * own start/stop actions should need this — everything else wants the
 * effective user.
 */
export async function requireActor(): Promise<CurrentDbUser> {
  const session = await getCurrentUser();
  if (!session?.id) redirect('/login');
  const actor = await loadUser(session.id);
  if (!actor) redirect('/login');
  const { hashedPassword, role, ...rest } = actor;
  return {
    ...rest,
    hasPassword: Boolean(hashedPassword),
    roleName: role?.name ?? 'Agent',
    permissions: (role?.permissions ?? []) as string[],
    impersonatedBy: null,
  };
}

/**
 * Page-level guard. Unlike `requirePermission` this redirects rather than
 * throwing — someone who follows a stale admin link should land on their own
 * settings, not on an error page — and it permits reads while viewing as
 * someone, which is the entire point of viewing as them.
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
