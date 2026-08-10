/* @license Enterprise */

import {
  verifyLicenseKey,
  resolveGrantedFeatures,
  type LicenseInvalidReason,
  type LicenseVerification,
} from './license.js';
import { licenseGrants, type EnterpriseFeature } from './features.js';

/**
 * The single place the rest of the app asks "is this feature paid for?".
 *
 * Reads the environment once and caches, in the same shape as `loadConfig` in
 * `@comms/core`. Absence of a license is not an error: no key means community
 * edition, every Enterprise feature off, everything else untouched.
 */

/**
 * Public half of the Ed25519 keypair used to sign license keys, baked into the
 * build so verification works offline.
 *
 * Empty in the open source tree on purpose — there is no shared secret to leak,
 * and a fork should sign with its own key rather than inherit ours. Generate a
 * pair with `node packages/enterprise/scripts/issue-license.mjs keygen`, paste
 * the public half here, and keep the private half in your issuing system.
 */
export const BUILTIN_LICENSE_PUBLIC_KEY = '';

export interface SeatStatus {
  /** Licensed seats; 0 means unlimited. */
  seats: number;
  activeUsers: number;
  withinLimit: boolean;
  /** How many users beyond the licensed count; 0 when within limit. */
  overage: number;
}

export interface EnterpriseStatus {
  /** True when a valid key is present and at least one feature is granted. */
  licensed: boolean;
  edition: 'community' | 'enterprise';
  /** Who the license was issued to, for the admin panel. */
  issuedTo: string | null;
  /** Licensed seats; 0 means unlimited. */
  seats: number;
  features: EnterpriseFeature[];
  expiresAt: Date | null;
  daysRemaining: number | null;
  /** Past expiry but inside the grace window — renew now, still working. */
  inGrace: boolean;
  /**
   * Set only when a key was supplied and could not be used. Running with no key
   * at all is the normal community-edition state, not a problem to report.
   */
  problem: { reason: LicenseInvalidReason; message: string } | null;
}

const COMMUNITY: EnterpriseStatus = {
  licensed: false,
  edition: 'community',
  issuedTo: null,
  seats: 0,
  features: [],
  expiresAt: null,
  daysRemaining: null,
  inGrace: false,
  problem: null,
};

let cached: EnterpriseStatus | undefined;

/** Shape a verification result into the status the app consumes. */
function toStatus(result: LicenseVerification): EnterpriseStatus {
  if (!result.valid) {
    return {
      ...COMMUNITY,
      problem:
        result.reason === 'missing' ? null : { reason: result.reason, message: result.message },
    };
  }

  const features = resolveGrantedFeatures(result.claims) as EnterpriseFeature[];
  return {
    licensed: features.length > 0,
    edition: features.length > 0 ? 'enterprise' : 'community',
    issuedTo: result.claims.sub,
    seats: result.claims.seats,
    features,
    expiresAt: result.claims.exp === 0 ? null : new Date(result.claims.exp * 1000),
    daysRemaining: result.daysRemaining,
    inGrace: result.inGrace,
    problem: null,
  };
}

/**
 * Resolve the current license status, caching after the first call.
 *
 * Never throws: a malformed or expired key degrades to community edition with
 * `problem` set, because a bad license should disable paid features, not stop
 * the shared inbox from serving messages.
 */
export function loadEnterprise(env: NodeJS.ProcessEnv = process.env): EnterpriseStatus {
  if (cached) return cached;

  const publicKey = env.COMMS_LICENSE_PUBLIC_KEY?.trim() || BUILTIN_LICENSE_PUBLIC_KEY;
  cached = toStatus(verifyLicenseKey(env.COMMS_LICENSE_KEY, publicKey));
  return cached;
}

/** Is a paid feature available on this instance? Safe to call anywhere. */
export function hasFeature(feature: EnterpriseFeature): boolean {
  return licenseGrants(loadEnterprise().features, feature);
}

/**
 * Assert a paid feature before doing paid work. Use at the entry point of an
 * Enterprise code path — a server action or a job handler — not deep inside it.
 */
export function requireFeature(feature: EnterpriseFeature): void {
  if (hasFeature(feature)) return;
  const status = loadEnterprise();
  throw new EnterpriseFeatureRequiredError(feature, status.problem?.message);
}

export class EnterpriseFeatureRequiredError extends Error {
  readonly feature: EnterpriseFeature;

  constructor(feature: EnterpriseFeature, detail?: string) {
    super(
      `The "${feature}" feature requires a Comms Enterprise subscription.` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'EnterpriseFeatureRequiredError';
    this.feature = feature;
  }
}

/**
 * Compare active users against the licensed seat count.
 *
 * Reports; it does not enforce. Locking people out of a support queue because
 * an invoice is late is worse for the customer than a banner is for us, so
 * callers surface an overage in the admin panel and leave sign-in alone.
 */
export function seatStatus(activeUsers: number, status = loadEnterprise()): SeatStatus {
  const seats = status.seats;
  const overage = seats === 0 ? 0 : Math.max(0, activeUsers - seats);
  return { seats, activeUsers, withinLimit: overage === 0, overage };
}

/** Reset the cache (tests only, and after a license key is changed at runtime). */
export function _resetEnterpriseCache(): void {
  cached = undefined;
}
