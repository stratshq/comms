/* @license Enterprise */

/**
 * Enterprise SSO seam: SAML 2.0 / OIDC against a customer's identity provider,
 * plus SCIM directory sync.
 *
 * Distinct from the Google and GitHub sign-in in `apps/web/src/auth.ts`, which
 * is free and stays free. What is paid for here is the part enterprises
 * actually buy: their own IdP, enforced, with provisioning and deprovisioning
 * driven by the directory rather than by an admin remembering.
 */

export type SsoProtocol = 'saml' | 'oidc';

export interface SsoConnection {
  id: string;
  protocol: SsoProtocol;
  /** Display name shown on the sign-in button. */
  label: string;
  /**
   * Email domains routed to this connection, lowercased and without the `@`.
   * A domain must be verified before it can be claimed, or anyone could
   * intercept sign-in for a domain they do not own.
   */
  domains: string[];
  /** SAML IdP metadata URL, or OIDC issuer URL. */
  issuer: string;
  enabled: boolean;
}

export interface SsoPolicy {
  /**
   * When true, users whose email domain matches a connection must sign in
   * through it — password and social sign-in are refused for them. The escape
   * hatch is deliberate: accounts holding `system.admin` are exempt so a
   * misconfigured IdP cannot lock every administrator out of the workspace.
   */
  enforceForMatchedDomains: boolean;
  /** Create an account on first successful IdP sign-in, instead of requiring an invite. */
  autoProvision: boolean;
  /** Role assigned to auto-provisioned users. */
  defaultRoleId: string;
}

export const DEFAULT_SSO_POLICY: SsoPolicy = {
  enforceForMatchedDomains: false,
  autoProvision: false,
  defaultRoleId: 'role_agent',
};

/** The domain part of an email address, lowercased. Null when unparseable. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * Which connection, if any, should handle this address.
 *
 * Pure and dependency-free so the sign-in page can call it on every attempt
 * without a round trip, and so the routing rule is unit-testable on its own.
 * Disabled connections never match.
 */
export function connectionForEmail(
  email: string,
  connections: readonly SsoConnection[],
): SsoConnection | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  return connections.find((c) => c.enabled && c.domains.includes(domain)) ?? null;
}

/**
 * Is this user required to use SSO? Callers pass `isAdmin` for accounts holding
 * `system.admin`, which are always exempt — see `SsoPolicy`.
 */
export function mustUseSso(
  email: string,
  connections: readonly SsoConnection[],
  policy: SsoPolicy,
  isAdmin: boolean,
): boolean {
  if (!policy.enforceForMatchedDomains || isAdmin) return false;
  return connectionForEmail(email, connections) !== null;
}
