import { describe, it, expect } from 'vitest';
import {
  IMPERSONATION_MAX_AGE_SECONDS,
  checkCanImpersonate,
  decodeTicket,
  encodeTicket,
} from '../src/lib/impersonation';

const SECRET = 'test-app-secret-at-least-16-chars';
const OWNER = ['*'];
const ADMIN = ['system.admin', 'system.impersonate', 'users.manage'];
const AGENT: string[] = [];

describe('ticket encoding', () => {
  it('round-trips a ticket', () => {
    const ticket = { actorId: 'usr_a', targetId: 'usr_b', issuedAt: Date.now() };
    expect(decodeTicket(encodeTicket(ticket, SECRET), SECRET)).toEqual(ticket);
  });

  it('rejects a ticket signed with a different secret', () => {
    const raw = encodeTicket({ actorId: 'usr_a', targetId: 'usr_b', issuedAt: Date.now() }, SECRET);
    expect(decodeTicket(raw, 'another-secret-entirely-here')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const raw = encodeTicket({ actorId: 'usr_a', targetId: 'usr_b', issuedAt: Date.now() }, SECRET);
    const [payload, sig] = raw.split('.');
    const forged = Buffer.from(
      JSON.stringify({ actorId: 'usr_a', targetId: 'usr_victim', issuedAt: Date.now() }),
      'utf8',
    ).toString('base64url');
    expect(payload).not.toBe(forged);
    expect(decodeTicket(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects garbage and empty values without throwing', () => {
    expect(decodeTicket(undefined, SECRET)).toBeNull();
    expect(decodeTicket('', SECRET)).toBeNull();
    expect(decodeTicket('not-a-ticket', SECRET)).toBeNull();
    expect(decodeTicket('a.b', SECRET)).toBeNull();
  });

  it('expires past the maximum age', () => {
    const issuedAt = Date.now();
    const raw = encodeTicket({ actorId: 'usr_a', targetId: 'usr_b', issuedAt }, SECRET);
    const justInside = issuedAt + IMPERSONATION_MAX_AGE_SECONDS * 1000 - 1;
    const justOutside = issuedAt + IMPERSONATION_MAX_AGE_SECONDS * 1000 + 1;
    expect(decodeTicket(raw, SECRET, justInside)).not.toBeNull();
    expect(decodeTicket(raw, SECRET, justOutside)).toBeNull();
  });

  it('rejects a ticket minted in the future', () => {
    const raw = encodeTicket(
      { actorId: 'usr_a', targetId: 'usr_b', issuedAt: Date.now() + 10 * 60_000 },
      SECRET,
    );
    expect(decodeTicket(raw, SECRET)).toBeNull();
  });
});

describe('checkCanImpersonate', () => {
  const base = {
    actorPermissions: ADMIN,
    targetPermissions: AGENT,
    actorId: 'usr_admin',
    targetId: 'usr_agent',
    targetStatus: 'active',
    alreadyImpersonating: false,
  };

  it('allows an admin with the permission to view an agent', () => {
    expect(checkCanImpersonate(base)).toEqual({ ok: true });
  });

  it('allows an owner (wildcard) without the explicit key', () => {
    expect(checkCanImpersonate({ ...base, actorPermissions: OWNER })).toEqual({ ok: true });
  });

  it('refuses an actor without the permission', () => {
    const v = checkCanImpersonate({ ...base, actorPermissions: ['users.manage'] });
    expect(v.ok).toBe(false);
  });

  it('refuses to view as an account with full access', () => {
    const v = checkCanImpersonate({ ...base, targetPermissions: OWNER });
    expect(v.ok).toBe(false);
  });

  it('refuses even an owner viewing as another owner', () => {
    const v = checkCanImpersonate({
      ...base,
      actorPermissions: OWNER,
      targetPermissions: OWNER,
    });
    expect(v.ok).toBe(false);
  });

  it('refuses self-impersonation', () => {
    const v = checkCanImpersonate({ ...base, targetId: base.actorId });
    expect(v.ok).toBe(false);
  });

  it('refuses disabled and invited accounts', () => {
    expect(checkCanImpersonate({ ...base, targetStatus: 'disabled' }).ok).toBe(false);
    expect(checkCanImpersonate({ ...base, targetStatus: 'invited' }).ok).toBe(false);
  });

  it('refuses nesting', () => {
    const v = checkCanImpersonate({ ...base, alreadyImpersonating: true });
    expect(v.ok).toBe(false);
  });
});
