import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLicenseKey, resolveGrantedFeatures, LICENSE_GRACE_DAYS } from '../src/license';
import { licenseGrants, isEnterpriseFeature } from '../src/features';
import {
  loadEnterprise,
  hasFeature,
  requireFeature,
  seatStatus,
  _resetEnterpriseCache,
} from '../src/gate';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_B64 = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64');

const NOW = new Date('2026-06-01T00:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

/** Mint a key the way scripts/issue-license.mjs does, dated around `base`. */
function issueAt(base: number, overrides: Record<string, unknown> = {}): string {
  const claims = {
    v: 1,
    sub: 'Acme Inc',
    seats: 25,
    features: ['*'],
    iat: base - 86_400,
    exp: base + 86_400 * 30,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return `comms_${payload}.${signature.toString('base64url')}`;
}

/** For assertions that pass an explicit `now` — dated against the frozen clock. */
const issue = (overrides: Record<string, unknown> = {}) => issueAt(nowSeconds, overrides);

/**
 * For the gate, which reads the real clock by design. Dating these against the
 * frozen clock would make them expire as wall-clock time moved past it.
 */
const issueLive = (overrides: Record<string, unknown> = {}) =>
  issueAt(Math.floor(Date.now() / 1000), overrides);

describe('verifyLicenseKey', () => {
  it('accepts a well-formed key and returns its claims', () => {
    const result = verifyLicenseKey(issue(), PUBLIC_B64, NOW);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims.sub).toBe('Acme Inc');
    expect(result.claims.seats).toBe(25);
    expect(result.daysRemaining).toBe(30);
    expect(result.inGrace).toBe(false);
  });

  it('accepts a PEM public key as well as a bare base64 one', () => {
    const pem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    expect(verifyLicenseKey(issue(), pem, NOW).valid).toBe(true);
  });

  it('reports a missing key without treating it as an error', () => {
    const result = verifyLicenseKey(undefined, PUBLIC_B64, NOW);
    expect(result).toMatchObject({ valid: false, reason: 'missing' });
  });

  it('rejects a key that is not prefixed', () => {
    expect(verifyLicenseKey('nope.nope', PUBLIC_B64, NOW)).toMatchObject({ reason: 'malformed' });
  });

  it('rejects a key with the wrong number of segments', () => {
    expect(verifyLicenseKey('comms_onlyonesegment', PUBLIC_B64, NOW)).toMatchObject({
      reason: 'malformed',
    });
  });

  it('rejects a tampered payload', () => {
    const key = issue();
    const [payload, signature] = key.slice('comms_'.length).split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, sub: 'Pirate', seats: 0, features: ['*'], iat: nowSeconds, exp: 0 }),
      'utf8',
    ).toString('base64url');
    expect(payload).not.toBe(forged);
    expect(verifyLicenseKey(`comms_${forged}.${signature}`, PUBLIC_B64, NOW)).toMatchObject({
      reason: 'bad-signature',
    });
  });

  it('rejects a key signed by a different keypair', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPublic = other.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64');
    expect(verifyLicenseKey(issue(), otherPublic, NOW)).toMatchObject({ reason: 'bad-signature' });
  });

  it('refuses to verify when no public key is configured', () => {
    expect(verifyLicenseKey(issue(), '', NOW)).toMatchObject({ reason: 'no-public-key' });
  });

  it('treats a perpetual license as never expiring', () => {
    const result = verifyLicenseKey(issue({ exp: 0 }), PUBLIC_B64, NOW);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.daysRemaining).toBeNull();
  });

  it('keeps working inside the grace period, flagged', () => {
    const result = verifyLicenseKey(issue({ exp: nowSeconds - 86_400 }), PUBLIC_B64, NOW);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.inGrace).toBe(true);
    expect(result.daysRemaining).toBeLessThan(0);
  });

  it('fails once past the grace period', () => {
    const expired = issue({ exp: nowSeconds - 86_400 * (LICENSE_GRACE_DAYS + 1) });
    expect(verifyLicenseKey(expired, PUBLIC_B64, NOW)).toMatchObject({ reason: 'expired' });
  });

  it('rejects a key dated in the future', () => {
    const result = verifyLicenseKey(issue({ iat: nowSeconds + 86_400 }), PUBLIC_B64, NOW);
    expect(result).toMatchObject({ reason: 'not-yet-valid' });
  });

  it('reports an unsupported claims version distinctly from malformed input', () => {
    expect(verifyLicenseKey(issue({ v: 2 }), PUBLIC_B64, NOW)).toMatchObject({
      reason: 'unsupported-version',
    });
  });
});

describe('feature resolution', () => {
  it('expands the wildcard to the whole catalog', () => {
    const result = verifyLicenseKey(issue(), PUBLIC_B64, NOW);
    if (!result.valid) throw new Error('expected a valid license');
    expect(resolveGrantedFeatures(result.claims)).toEqual(
      expect.arrayContaining(['billing', 'sso', 'audit-log']),
    );
  });

  it('drops feature keys this build does not know about', () => {
    const result = verifyLicenseKey(issue({ features: ['sso', 'time-travel'] }), PUBLIC_B64, NOW);
    if (!result.valid) throw new Error('expected a valid license');
    expect(resolveGrantedFeatures(result.claims)).toEqual(['sso']);
  });

  it('grants nothing for an empty list', () => {
    expect(licenseGrants([], 'sso')).toBe(false);
    expect(licenseGrants(null, 'sso')).toBe(false);
  });

  it('narrows unknown strings off the wire', () => {
    expect(isEnterpriseFeature('billing')).toBe(true);
    expect(isEnterpriseFeature('billling')).toBe(false);
  });
});

describe('gate', () => {
  beforeEach(() => _resetEnterpriseCache());

  it('falls back to community edition with no key', () => {
    const status = loadEnterprise({});
    expect(status.edition).toBe('community');
    expect(status.licensed).toBe(false);
    expect(status.problem).toBeNull();
  });

  it('reports a broken key as a problem rather than throwing', () => {
    const status = loadEnterprise({
      COMMS_LICENSE_KEY: 'comms_garbage.sig',
      COMMS_LICENSE_PUBLIC_KEY: PUBLIC_B64,
    });
    expect(status.edition).toBe('community');
    expect(status.problem?.reason).toBe('bad-signature');
  });

  it('unlocks features for a valid key', () => {
    loadEnterprise({
      COMMS_LICENSE_KEY: issueLive({ features: ['sso'] }),
      COMMS_LICENSE_PUBLIC_KEY: PUBLIC_B64,
    });
    expect(hasFeature('sso')).toBe(true);
    expect(hasFeature('billing')).toBe(false);
    expect(() => requireFeature('sso')).not.toThrow();
    expect(() => requireFeature('billing')).toThrow(/requires a Comms Enterprise subscription/);
  });

  it('treats zero seats as unlimited', () => {
    loadEnterprise({
      COMMS_LICENSE_KEY: issueLive({ seats: 0 }),
      COMMS_LICENSE_PUBLIC_KEY: PUBLIC_B64,
    });
    expect(seatStatus(10_000)).toMatchObject({ withinLimit: true, overage: 0 });
  });

  it('reports seat overage without blocking', () => {
    loadEnterprise({
      COMMS_LICENSE_KEY: issueLive({ seats: 5 }),
      COMMS_LICENSE_PUBLIC_KEY: PUBLIC_B64,
    });
    expect(seatStatus(8)).toMatchObject({
      seats: 5,
      activeUsers: 8,
      withinLimit: false,
      overage: 3,
    });
  });

  it('degrades to community edition once a key is past its grace period', () => {
    const longExpired = issueAt(Math.floor(Date.now() / 1000) - 86_400 * 400, { exp: 1 });
    const status = loadEnterprise({
      COMMS_LICENSE_KEY: longExpired,
      COMMS_LICENSE_PUBLIC_KEY: PUBLIC_B64,
    });
    expect(status.edition).toBe('community');
    expect(status.problem?.reason).toBe('expired');
  });
});
