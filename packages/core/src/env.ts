import { z } from 'zod';

/**
 * Centralized, validated configuration. The design goal is "only two required
 * env vars": DATABASE_URL / REDIS_URL come from referenced services. The app
 * secret is generated and stored in the database on first boot (it is NOT a
 * required var), and the public URL is derived from RAILWAY_PUBLIC_DOMAIN.
 * Everything else (SMTP, OAuth, S3, AI) is optional and configured later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  // Single shared secret used for session signing + encrypting integration
  // credentials at rest. On Railway this is generated with ${{ secret() }}.
  APP_SECRET: z.string().min(16).optional(),
  AUTH_SECRET: z.string().min(16).optional(),

  // Public URL handling. Prefer an explicit APP_URL; otherwise derive from Railway.
  APP_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  PORT: z.coerce.number().default(3000),

  // S3-compatible object storage (Railway Storage Bucket, R2, MinIO, AWS, …).
  // Optional: when unset, attachment storage is disabled but messaging still works.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // AI features (summarization, suggested replies, auto-triage). Optional —
  // when ANTHROPIC_API_KEY is unset, AI features are disabled and degrade cleanly.
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5'),

  // Outbound send pacing: minimum ms between sends per connection, to stay under
  // Apple's iMessage throttling. Applied globally per BlueBubbles number.
  SEND_MIN_INTERVAL_MS: z.coerce.number().default(800),

  // Hard send ceilings per connection (i.e. per Apple ID). Automated/high-volume
  // sending from one consumer Apple ID risks silent delivery degradation and
  // account bans (see the Sendblue/LoopMessage per-ID ceilings — low hundreds
  // per day). Sends beyond the cap are delayed, not dropped. Set 0 to disable.
  SEND_HOURLY_CAP: z.coerce.number().default(50),
  SEND_DAILY_CAP: z.coerce.number().default(300),

  // Voice-memo transcription. Optional and provider-agnostic: any
  // OpenAI-compatible /audio/transcriptions endpoint works. Anthropic's API
  // cannot accept audio, so this is necessarily a second provider. Unset means
  // we still use Apple's free on-device transcript when the sender's device
  // produced one — only the fallback is disabled.
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  TRANSCRIPTION_MODEL: z.string().default('whisper-large-v3-turbo'),
  TRANSCRIPTION_MAX_BYTES: z.coerce.number().default(24 * 1024 * 1024),

  // Undo-send: outbound messages sit in a delayed queue for this many seconds
  // before the worker picks them up, during which the sender can retract them.
  // 0 disables the window (sends dispatch immediately).
  UNDO_SEND_SECONDS: z.coerce.number().default(8),

  // SMTP (magic-link sign-in, invites, notifications). Optional.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type RawEnv = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export interface AppConfig extends RawEnv {
  appUrl: string;
  appSecret: string;
  authSecret: string;
  storageEnabled: boolean;
  smtpEnabled: boolean;
  aiEnabled: boolean;
  transcriptionEnabled: boolean;
}

function resolveAppUrl(env: RawEnv): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${env.PORT}`;
}

/**
 * Parse and cache config. Throws with a readable summary if validation fails.
 * `requireRuntime` enforces the vars needed to actually run (DB/Redis/secret);
 * keep it false for build-time contexts where those aren't present yet.
 */
export function loadConfig(requireRuntime = false): AppConfig {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  const appSecret = env.APP_SECRET ?? env.AUTH_SECRET;
  const authSecret = env.AUTH_SECRET ?? env.APP_SECRET;

  if (requireRuntime) {
    // APP_SECRET is intentionally NOT required — when unset, the app generates and
    // persists one in the database on first boot (see @comms/db ensureAppSecret),
    // which sets process.env.APP_SECRET before this runs. Only the datastores are
    // truly required, and on Railway both are one-click references.
    const missing: string[] = [];
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.REDIS_URL) missing.push('REDIS_URL');
    if (missing.length) {
      throw new Error(
        `Missing required runtime configuration: ${missing.join(', ')}.\n` +
          'On Railway these are wired automatically (Postgres/Redis service references).',
      );
    }
  }

  cached = {
    ...env,
    appUrl: resolveAppUrl(env),
    appSecret: appSecret ?? 'insecure-dev-secret-change-me',
    authSecret: authSecret ?? 'insecure-dev-secret-change-me',
    storageEnabled: Boolean(
      env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET,
    ),
    smtpEnabled: Boolean(env.SMTP_HOST && env.SMTP_FROM),
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    transcriptionEnabled: Boolean(env.TRANSCRIPTION_API_KEY),
  };
  return cached;
}

/** Reset the cache (tests only). */
export function _resetConfigCache() {
  cached = undefined;
}
