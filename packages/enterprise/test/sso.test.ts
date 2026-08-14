import { describe, it, expect } from 'vitest';
import {
  emailDomain,
  connectionForEmail,
  mustUseSso,
  DEFAULT_SSO_POLICY,
  type SsoConnection,
} from '../src/sso';

const okta: SsoConnection = {
  id: 'sso_1',
  protocol: 'saml',
  label: 'Acme SSO',
  domains: ['acme.com', 'acme.co.uk'],
  issuer: 'https://acme.okta.com',
  enabled: true,
};

const disabled: SsoConnection = { ...okta, id: 'sso_2', domains: ['old.com'], enabled: false };

describe('emailDomain', () => {
  it('lowercases the domain', () => {
    expect(emailDomain('Someone@ACME.com')).toBe('acme.com');
  });

  it('uses the last @ so quoted local parts do not confuse it', () => {
    expect(emailDomain('"weird@local"@acme.com')).toBe('acme.com');
  });

  it('returns null for input that is not an address', () => {
    expect(emailDomain('acme.com')).toBeNull();
    expect(emailDomain('@acme.com')).toBeNull();
    expect(emailDomain('someone@')).toBeNull();
  });
});

describe('connectionForEmail', () => {
  it('matches a claimed domain', () => {
    expect(connectionForEmail('jo@acme.com', [okta])?.id).toBe('sso_1');
    expect(connectionForEmail('jo@acme.co.uk', [okta])?.id).toBe('sso_1');
  });

  it('does not match an unclaimed domain', () => {
    expect(connectionForEmail('jo@gmail.com', [okta])).toBeNull();
  });

  it('ignores disabled connections', () => {
    expect(connectionForEmail('jo@old.com', [disabled])).toBeNull();
  });

  it('is case-insensitive on the address', () => {
    expect(connectionForEmail('JO@Acme.COM', [okta])?.id).toBe('sso_1');
  });
});

describe('mustUseSso', () => {
  const enforcing = { ...DEFAULT_SSO_POLICY, enforceForMatchedDomains: true };

  it('is off unless enforcement is enabled', () => {
    expect(mustUseSso('jo@acme.com', [okta], DEFAULT_SSO_POLICY, false)).toBe(false);
  });

  it('requires SSO for a matched domain when enforcing', () => {
    expect(mustUseSso('jo@acme.com', [okta], enforcing, false)).toBe(true);
  });

  it('leaves unmatched domains alone', () => {
    expect(mustUseSso('jo@gmail.com', [okta], enforcing, false)).toBe(false);
  });

  it('always exempts admins, so a broken IdP cannot lock out the workspace', () => {
    expect(mustUseSso('jo@acme.com', [okta], enforcing, true)).toBe(false);
  });
});
