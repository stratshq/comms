import { loadConfig } from '@comms/core';
import { getRuntimeOverrides } from '@comms/db';
import { SUGGESTED_MODELS } from '@comms/ai';
import {
  getAdminOverview,
  getSystemHealth,
  getVersionInfo,
  listAiProvidersSafe,
} from '@/server/system';
import { AdminPanel } from '@/components/settings/admin-panel';

export const dynamic = 'force-dynamic';

export default async function AdminPanelPage() {
  const cfg = loadConfig();
  const [version, health, overview, ai, overrides] = await Promise.all([
    getVersionInfo(),
    getSystemHealth(),
    getAdminOverview(),
    listAiProvidersSafe(),
    getRuntimeOverrides(),
  ]);

  // What the deployment is, in one glance — values only, never secrets.
  const readOnlyConfig = [
    { label: 'Public URL', value: cfg.appUrl },
    { label: 'Database', value: cfg.DATABASE_URL ? 'configured' : 'missing' },
    { label: 'Redis', value: cfg.REDIS_URL ? 'configured' : 'missing' },
    { label: 'Attachments (S3)', value: cfg.storageEnabled ? 'configured' : 'not configured' },
    { label: 'Email (SMTP)', value: cfg.smtpEnabled ? 'configured' : 'not configured' },
    {
      label: 'Google sign-in',
      value: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not configured',
    },
    {
      label: 'GitHub sign-in',
      value: process.env.GITHUB_CLIENT_ID ? 'configured' : 'not configured',
    },
    {
      label: 'AI (environment)',
      value: cfg.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY · ${cfg.AI_MODEL}` : 'not set',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Admin panel</h2>
        <p className="text-sm text-muted-foreground">
          The machine room: version, providers, runtime settings and service health.
        </p>
      </div>

      <AdminPanel
        version={version}
        health={health}
        admins={overview.admins.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          role: a.role,
          image: a.image,
        }))}
        recentUsers={overview.recent.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        }))}
        providers={ai.providers}
        envAnthropicKey={ai.envAnthropicKey}
        envModel={ai.envModel}
        overrides={overrides}
        envDefaults={{
          undoSendSeconds: cfg.UNDO_SEND_SECONDS,
          sendHourlyCap: cfg.SEND_HOURLY_CAP,
          sendDailyCap: cfg.SEND_DAILY_CAP,
          sendMinIntervalMs: cfg.SEND_MIN_INTERVAL_MS,
        }}
        readOnlyConfig={readOnlyConfig}
        suggestedModels={SUGGESTED_MODELS}
      />
    </div>
  );
}
