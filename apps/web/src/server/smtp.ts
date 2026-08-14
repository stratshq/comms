import 'server-only';
import nodemailer from 'nodemailer';
import { encryptSecret, decryptSecret, loadConfig } from '@comms/core';
import { getSetting, setSetting } from '@/server/settings';

/**
 * Email settings, editable at runtime.
 *
 * SMTP arrived as environment variables, which means a self-hoster who wants
 * invite emails has to go back to the Railway dashboard and redeploy. These
 * settings live in the database instead and take precedence over the
 * environment, so email can be turned on from inside the app.
 *
 * One honest limitation, stated here and in the UI: magic-link SIGN-IN is
 * wired into Auth.js, whose provider list is built once when the server starts
 * (`buildProviders()` in `@/auth`). Settings saved here apply immediately to
 * mail the app sends itself — invites, notifications, the test message — but
 * magic-link sign-in picks them up on the next restart. Pretending otherwise
 * would mean a settings page that lies about when a change takes effect.
 */

const KEY = 'smtp';

interface StoredSmtp {
  host: string;
  port: number;
  user?: string;
  passwordEncrypted?: string;
  from: string;
  secure?: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  /** Never returned to the client — presence only. */
  hasPassword: boolean;
  from: string;
  secure: boolean;
}

export interface EmailStatus {
  /** Where the effective settings come from. */
  source: 'database' | 'environment' | 'none';
  configured: boolean;
  settings: SmtpSettings | null;
}

/** The stored override, decrypted for server-side use. */
async function resolveStored(): Promise<
  (StoredSmtp & { password?: string }) | null
> {
  const row = await getSetting<StoredSmtp>(KEY);
  if (!row?.host || !row?.from) return null;
  let password: string | undefined;
  if (row.passwordEncrypted) {
    try {
      password = decryptSecret(row.passwordEncrypted, loadConfig().appSecret);
    } catch {
      password = undefined;
    }
  }
  return { ...row, password };
}

/** What the admin panel shows: effective config and where it came from. */
export async function getEmailStatus(): Promise<EmailStatus> {
  const stored = await resolveStored();
  if (stored) {
    return {
      source: 'database',
      configured: true,
      settings: {
        host: stored.host,
        port: stored.port,
        user: stored.user ?? '',
        hasPassword: Boolean(stored.passwordEncrypted),
        from: stored.from,
        secure: stored.secure ?? stored.port === 465,
      },
    };
  }

  const cfg = loadConfig();
  if (cfg.smtpEnabled) {
    return {
      source: 'environment',
      configured: true,
      settings: {
        host: cfg.SMTP_HOST ?? '',
        port: cfg.SMTP_PORT ?? 587,
        user: cfg.SMTP_USER ?? '',
        hasPassword: Boolean(cfg.SMTP_PASSWORD),
        from: cfg.SMTP_FROM ?? '',
        secure: (cfg.SMTP_PORT ?? 587) === 465,
      },
    };
  }

  return { source: 'none', configured: false, settings: null };
}

export interface SaveSmtpInput {
  host: string;
  port: number;
  user?: string;
  /** Omit to keep the stored password; empty string clears it. */
  password?: string;
  from: string;
  secure?: boolean;
}

export async function saveSmtpSettings(input: SaveSmtpInput): Promise<void> {
  const existing = await getSetting<StoredSmtp>(KEY);
  const passwordEncrypted =
    input.password === undefined
      ? existing?.passwordEncrypted
      : input.password === ''
        ? undefined
        : encryptSecret(input.password, loadConfig().appSecret);

  await setSetting(KEY, {
    host: input.host.trim(),
    port: input.port,
    user: input.user?.trim() || undefined,
    passwordEncrypted,
    from: input.from.trim(),
    secure: input.secure ?? input.port === 465,
  } satisfies StoredSmtp);
}

/** Drop the override and fall back to the environment. */
export async function clearSmtpSettings(): Promise<void> {
  await setSetting(KEY, null);
}

/**
 * A transport built per send, from whatever the effective settings are right
 * now. Built fresh rather than cached precisely so a settings change applies
 * to the very next message without a restart.
 */
export async function createTransport() {
  const stored = await resolveStored();
  if (stored) {
    return nodemailer.createTransport({
      host: stored.host,
      port: stored.port,
      secure: stored.secure ?? stored.port === 465,
      auth: stored.user && stored.password ? { user: stored.user, pass: stored.password } : undefined,
    });
  }

  const cfg = loadConfig();
  if (!cfg.smtpEnabled) return null;
  return nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT ?? 587,
    secure: (cfg.SMTP_PORT ?? 587) === 465,
    auth:
      cfg.SMTP_USER && cfg.SMTP_PASSWORD
        ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD }
        : undefined,
  });
}

async function resolveFrom(): Promise<string | null> {
  const stored = await resolveStored();
  if (stored) return stored.from;
  return loadConfig().SMTP_FROM ?? null;
}

export type SendMailResult = { ok: true } | { ok: false; error: string };

/** Send one message through the effective settings. */
export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult> {
  const transport = await createTransport();
  const from = await resolveFrom();
  if (!transport || !from) {
    return { ok: false, error: 'Email is not configured yet.' };
  }
  try {
    await transport.sendMail({ from, ...input });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
