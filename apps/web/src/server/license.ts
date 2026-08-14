import 'server-only';
import { encryptSecret, decryptSecret, loadConfig } from '@comms/core';
import { getSetting, setSetting } from '@/server/settings';

/**
 * Enterprise licensing.
 *
 * Deliberately honest: there is no licensing server and no cryptographic
 * proof. Storing a key marks the instance as licensed and unlocks the features
 * flagged enterprise-only. That is an honour-system gate on a self-hosted,
 * MIT-licensed product — anyone determined can edit a row — and the UI says
 * so rather than implying a lock that isn't there.
 *
 * The key is still stored ENCRYPTED, because it is a credential a customer
 * gave us and a database dump should not hand it to the next reader.
 */

const KEY = 'license';

interface StoredLicense {
  keyEncrypted: string;
  activatedAt: string;
  /** Free-text label from the key holder, e.g. the company name. */
  label?: string;
}

export interface LicenseState {
  licensed: boolean;
  /** Last four characters only — enough to confirm which key is installed. */
  keyHint: string | null;
  activatedAt: string | null;
  label: string | null;
}

export async function getLicense(): Promise<LicenseState> {
  const row = await getSetting<StoredLicense>(KEY);
  if (!row?.keyEncrypted) {
    return { licensed: false, keyHint: null, activatedAt: null, label: null };
  }
  let hint: string | null = null;
  try {
    const plain = decryptSecret(row.keyEncrypted, loadConfig().appSecret);
    hint = plain.slice(-4);
  } catch {
    // A key encrypted under a different APP_SECRET can't be read back. Report
    // it as licensed-but-unreadable rather than silently unlicensed, so the
    // operator can see that re-entering it is what's needed.
    hint = null;
  }
  return {
    licensed: true,
    keyHint: hint,
    activatedAt: row.activatedAt,
    label: row.label ?? null,
  };
}

/** True when enterprise-only features should be available. */
export async function isEnterprise(): Promise<boolean> {
  return (await getLicense()).licensed;
}

export async function activateLicense(key: string, label?: string): Promise<void> {
  await setSetting(KEY, {
    keyEncrypted: encryptSecret(key, loadConfig().appSecret),
    activatedAt: new Date().toISOString(),
    label: label?.trim() || undefined,
  } satisfies StoredLicense);
}

export async function deactivateLicense(): Promise<void> {
  await setSetting(KEY, null);
}
