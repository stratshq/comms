/* @license Enterprise */

/**
 * The Enterprise feature catalog.
 *
 * Every capability gated behind a subscription is gated on exactly one of these
 * keys, in the same spirit as the permission catalog in `@comms/db` — one flat,
 * readable list, so "what does paying get you" is answerable by reading a file
 * rather than by grepping for conditionals.
 *
 * Nothing here is required to run Comms. The AGPLv3 portion of the repository
 * is a complete product; these are additions on top of it.
 */
export const ENTERPRISE_FEATURES = [
  {
    key: 'billing',
    label: 'Billing & subscriptions',
    description:
      'Metered seats, plan management, invoices, and the payment-provider webhooks behind them. Powers Comms Cloud; irrelevant to most self-hosted installs.',
  },
  {
    key: 'sso',
    label: 'Enterprise SSO & directory sync',
    description:
      'SAML 2.0 and OIDC against an identity provider, SCIM user provisioning, and domain-verified auto-join. Distinct from the Google and GitHub sign-in that ships free.',
  },
  {
    key: 'audit-log',
    label: 'Audit log retention & export',
    description:
      'Configurable retention, filtered search, and CSV/SIEM export over the audit trail. The audit_logs table and its writes are open source; this is the compliance surface on top.',
  },
] as const;

export type EnterpriseFeature = (typeof ENTERPRISE_FEATURES)[number]['key'];

export const ALL_ENTERPRISE_FEATURES: EnterpriseFeature[] = ENTERPRISE_FEATURES.map((f) => f.key);

/** `'*'` in a license grants every feature, including ones added in later releases. */
export const WILDCARD_FEATURE = '*';

/** Is `value` a key in the catalog? Narrows unknown strings off the wire. */
export function isEnterpriseFeature(value: string): value is EnterpriseFeature {
  return (ALL_ENTERPRISE_FEATURES as string[]).includes(value);
}

/**
 * Does a licensed feature list cover a capability? The one predicate every gate
 * resolves to. Kept separate from license loading so it can be unit-tested and
 * reused against a license that arrived from somewhere other than the
 * environment.
 */
export function licenseGrants(
  features: readonly string[] | null | undefined,
  feature: EnterpriseFeature,
): boolean {
  if (!features?.length) return false;
  return features.includes(WILDCARD_FEATURE) || features.includes(feature);
}
