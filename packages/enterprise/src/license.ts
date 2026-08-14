/* @license Enterprise */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ALL_ENTERPRISE_FEATURES, WILDCARD_FEATURE } from './features.js';

/**
 * Offline license key verification.
 *
 * A key is an Ed25519 signature over a JSON claims blob, and nothing else. It
 * verifies with a public key that ships in the binary, so a self-hosted install
 * never phones home, keeps working when our servers are down, and works behind
 * an air gap. The tradeoff — no revocation before expiry — is handled by
 * issuing short-dated keys and reissuing on renewal, not by adding a callback.
 *
 * Format:
 *
 *     comms_<base64url(claims JSON)>.<base64url(Ed25519 signature)>
 *
 * The signature covers the base64url payload segment exactly as it appears in
 * the key, so verification never depends on JSON key ordering or whitespace
 * surviving a round trip.
 */

const KEY_PREFIX = 'comms_';

/** Ed25519 SPKI DER prefix, for accepting a bare 32-byte public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Days a lapsed license keeps working. A failed renewal should page someone,
 * not take a support desk offline mid-shift.
 */
export const LICENSE_GRACE_DAYS = 14;

const claimsSchema = z.object({
  /** Claims format version. Bumped only for incompatible changes. */
  v: z.literal(1),
  /** Who the license was issued to, for display in the admin panel. */
  sub: z.string().min(1),
  /** Licensed seat count. 0 means unlimited. */
  seats: z.number().int().nonnegative().default(0),
  /** Granted feature keys, or `['*']` for everything. */
  features: z.array(z.string()).default([]),
  /** Issued-at, in unix seconds. */
  iat: z.number().int().nonnegative(),
  /** Expiry, in unix seconds. 0 means perpetual. */
  exp: z.number().int().nonnegative(),
});

export type LicenseClaims = z.infer<typeof claimsSchema>;

export type LicenseInvalidReason =
  | 'missing'
  | 'malformed'
  | 'unsupported-version'
  | 'no-public-key'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired';

export type LicenseVerification =
  | {
      valid: true;
      claims: LicenseClaims;
      /** True once past `exp` but still inside the grace window. */
      inGrace: boolean;
      /** Whole days until expiry; null when perpetual. Negative inside grace. */
      daysRemaining: number | null;
    }
  | { valid: false; reason: LicenseInvalidReason; message: string };

function invalid(reason: LicenseInvalidReason, message: string): LicenseVerification {
  return { valid: false, reason, message };
}

/**
 * Accept either a PEM SPKI block or a bare base64 32-byte Ed25519 public key.
 * The bare form exists because PEM does not survive a single-line env var
 * without escaping, and operators paste these into dashboards.
 */
export function parseLicensePublicKey(raw: string): KeyObject | null {
  const value = raw.trim();
  if (!value) return null;

  try {
    if (value.includes('-----BEGIN')) {
      return createPublicKey({ key: value, format: 'pem' });
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/**
 * Verify a license key against a public key.
 *
 * `now` is injectable so expiry behaviour is testable without freezing the
 * system clock. Everything here is pure given those three inputs.
 */
export function verifyLicenseKey(
  key: string | null | undefined,
  publicKey: string | KeyObject | null | undefined,
  now: Date = new Date(),
): LicenseVerification {
  const trimmed = key?.trim();
  if (!trimmed) return invalid('missing', 'No license key configured.');

  if (!trimmed.startsWith(KEY_PREFIX)) {
    return invalid('malformed', `License keys start with "${KEY_PREFIX}".`);
  }

  const body = trimmed.slice(KEY_PREFIX.length);
  const parts = body.split('.');
  const payloadSegment = parts[0];
  const signatureSegment = parts[1];
  if (parts.length !== 2 || !payloadSegment || !signatureSegment) {
    return invalid('malformed', 'Expected exactly one "." separating payload from signature.');
  }

  const resolvedKey =
    typeof publicKey === 'string' ? parseLicensePublicKey(publicKey) : (publicKey ?? null);
  if (!resolvedKey) {
    return invalid(
      'no-public-key',
      'No license public key is configured, so this build cannot verify license keys.',
    );
  }

  // Verify before parsing: never hand attacker-controlled JSON to the rest of
  // the system on the strength of it merely being well formed.
  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      null,
      Buffer.from(payloadSegment, 'utf8'),
      resolvedKey,
      Buffer.from(signatureSegment, 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return invalid('bad-signature', 'License key signature does not verify.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return invalid('malformed', 'License payload is not valid JSON.');
  }

  const parsed = claimsSchema.safeParse(raw);
  if (!parsed.success) {
    const version = (raw as { v?: unknown } | null)?.v;
    if (typeof version === 'number' && version !== 1) {
      return invalid(
        'unsupported-version',
        `License claims version ${version} needs a newer build of Comms.`,
      );
    }
    return invalid('malformed', 'License payload is missing required claims.');
  }
  const claims = parsed.data;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.iat > nowSeconds + 60 * 60) {
    return invalid('not-yet-valid', 'License key is dated in the future.');
  }

  if (claims.exp === 0) {
    return { valid: true, claims, inGrace: false, daysRemaining: null };
  }

  const secondsLeft = claims.exp - nowSeconds;
  const daysRemaining = Math.floor(secondsLeft / 86_400);
  const graceSeconds = LICENSE_GRACE_DAYS * 86_400;

  if (secondsLeft <= -graceSeconds) {
    return invalid(
      'expired',
      `License expired on ${new Date(claims.exp * 1000).toISOString().slice(0, 10)}, past the ${LICENSE_GRACE_DAYS}-day grace period.`,
    );
  }

  return { valid: true, claims, inGrace: secondsLeft < 0, daysRemaining };
}

/**
 * Expand a claims feature list into concrete catalog keys, resolving `'*'` and
 * dropping anything this build does not recognise (a newer key used against an
 * older binary).
 */
export function resolveGrantedFeatures(claims: LicenseClaims): string[] {
  if (claims.features.includes(WILDCARD_FEATURE)) return [...ALL_ENTERPRISE_FEATURES];
  return claims.features.filter((f) => (ALL_ENTERPRISE_FEATURES as string[]).includes(f));
}
