import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * View-as (impersonation) tickets.
 *
 * A super admin can open a READ-ONLY session as another user to see exactly
 * what they see. The ticket lives in a signed cookie rather than in the JWT
 * because the JWT is only re-issued at sign-in — a ticket baked into it could
 * outlive the act of stopping, which is the one thing this must never do.
 *
 * The ticket carries the ACTOR as well as the target. Every read re-checks
 * that the actor id still matches the live session, so a stolen or stale
 * cookie is inert the moment the browser is signed into a different account,
 * and signing out (which drops the session) ends impersonation by
 * construction.
 *
 * Pure functions only — no database, no `next/headers` — so the rules are
 * unit-testable.
 */

export const IMPERSONATION_COOKIE = 'comms_view_as';

/** Hard ceiling on a ticket's life. Re-open it if you need longer. */
export const IMPERSONATION_MAX_AGE_SECONDS = 60 * 60;

export interface ImpersonationTicket {
  /** The real signed-in user who started this. */
  actorId: string;
  /** Whose session is being viewed. */
  targetId: string;
  /** Epoch milliseconds when the ticket was minted. */
  issuedAt: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Serialize + sign a ticket for storage in a cookie. */
export function encodeTicket(ticket: ImpersonationTicket, secret: string): string {
  const payload = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify and parse a cookie value. Returns null for anything that is not a
 * well-formed, correctly-signed, unexpired ticket — callers treat null as
 * "not impersonating" rather than as an error, so a corrupt cookie degrades
 * to the actor's own session instead of locking them out.
 */
export function decodeTicket(
  raw: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): ImpersonationTicket | null {
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const t = parsed as Partial<ImpersonationTicket>;
  if (typeof t.actorId !== 'string' || typeof t.targetId !== 'string') return null;
  if (typeof t.issuedAt !== 'number' || !Number.isFinite(t.issuedAt)) return null;
  if (now - t.issuedAt > IMPERSONATION_MAX_AGE_SECONDS * 1000) return null;
  // A ticket minted in the future is a clock problem or a forgery attempt.
  if (t.issuedAt - now > 60_000) return null;

  return { actorId: t.actorId, targetId: t.targetId, issuedAt: t.issuedAt };
}

export type ImpersonationVerdict = { ok: true } | { ok: false; error: string };

/**
 * May this actor view as this target?
 *
 * Deliberately strict, and separate from the cookie mechanics so the rules
 * can be tested directly:
 *
 * - Only a holder of `system.impersonate` may start one at all.
 * - Nobody may view as a user whose own role grants everything (`*`). Being
 *   able to wear an owner's session is indistinguishable from being an owner,
 *   which would make the "only an owner can grant Owner" rule pointless.
 * - Nobody may view as themselves — a no-op that only muddies the audit log.
 * - Disabled accounts are not viewable; there is nothing to see and it would
 *   resurrect access that was deliberately removed.
 * - No nesting: an impersonated session cannot start another.
 */
export function checkCanImpersonate(input: {
  actorPermissions: readonly string[];
  targetPermissions: readonly string[];
  actorId: string;
  targetId: string;
  targetStatus: string;
  alreadyImpersonating: boolean;
}): ImpersonationVerdict {
  if (input.alreadyImpersonating) {
    return { ok: false, error: 'Stop the current session before starting another.' };
  }
  if (input.actorId === input.targetId) {
    return { ok: false, error: 'You are already yourself.' };
  }
  const grants = (perms: readonly string[], key: string) =>
    perms.includes('*') || perms.includes(key);

  if (!grants(input.actorPermissions, 'system.impersonate')) {
    return { ok: false, error: 'You do not have permission to view as another user.' };
  }
  if (input.targetPermissions.includes('*')) {
    return { ok: false, error: 'Accounts with full access cannot be viewed as.' };
  }
  if (input.targetStatus !== 'active') {
    return { ok: false, error: 'Only active accounts can be viewed as.' };
  }
  return { ok: true };
}
