'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { eq } from '@comms/db';
import { users, auditLogs } from '@comms/db';
import { loadConfig } from '@comms/core';
import { db } from '@/server/db';
import { requireActor, requireDbUser } from '@/lib/session';
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_MAX_AGE_SECONDS,
  checkCanImpersonate,
  encodeTicket,
} from '@/lib/impersonation';

export type ImpersonationResult = { ok: true } | { ok: false; error: string };

/**
 * Start viewing as another user.
 *
 * Read-only by construction: the ticket only changes which user the session
 * resolves to, and every mutating server action goes through `requireWriter`,
 * which refuses while a ticket is active.
 */
export async function startImpersonation(targetId: string): Promise<ImpersonationResult> {
  // The ACTOR, deliberately — asking "who am I really" is the whole point, and
  // reading the effective user here would let a ticket authorize its successor.
  const actor = await requireActor();
  const effective = await requireDbUser();

  const target = await db.query.users.findFirst({
    where: eq(users.id, targetId),
    columns: { id: true, name: true, email: true, status: true },
    with: { role: { columns: { name: true, permissions: true } } },
  });
  if (!target) return { ok: false, error: 'User not found.' };

  const verdict = checkCanImpersonate({
    actorPermissions: actor.permissions,
    targetPermissions: target.role?.permissions ?? [],
    actorId: actor.id,
    targetId: target.id,
    targetStatus: target.status,
    alreadyImpersonating: Boolean(effective.impersonatedBy),
  });
  if (!verdict.ok) return verdict;

  const jar = await cookies();
  jar.set(
    IMPERSONATION_COOKIE,
    encodeTicket(
      { actorId: actor.id, targetId: target.id, issuedAt: Date.now() },
      loadConfig().appSecret,
    ),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: IMPERSONATION_MAX_AGE_SECONDS,
    },
  );

  await db.insert(auditLogs).values({
    actorUserId: actor.id,
    action: 'impersonation.start',
    entityType: 'user',
    entityId: target.id,
    metadata: {
      targetEmail: target.email,
      targetName: target.name,
      targetRole: target.role?.name ?? null,
    },
  });

  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * Stop viewing as someone and return to your own session.
 *
 * Never fails on authorization: whoever holds the cookie must always be able
 * to put it down, even if their own permissions changed mid-session.
 */
export async function stopImpersonation(): Promise<ImpersonationResult> {
  const effective = await requireDbUser();
  const jar = await cookies();
  jar.delete(IMPERSONATION_COOKIE);

  if (effective.impersonatedBy) {
    await db.insert(auditLogs).values({
      actorUserId: effective.impersonatedBy.id,
      action: 'impersonation.stop',
      entityType: 'user',
      entityId: effective.id,
      metadata: { targetEmail: effective.email, targetName: effective.name },
    });
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}
