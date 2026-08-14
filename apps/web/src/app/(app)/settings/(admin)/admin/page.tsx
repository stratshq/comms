import { requirePermissionPage } from '@/lib/session';
import { loadConfig } from '@comms/core';
import { getRuntimeOverrides } from '@comms/db';
import { KNOWN_MODELS, SUGGESTED_MODELS } from '@comms/ai';
import {
  getAdminOverview,
  getSystemHealth,
  getVersionInfo,
  listAiProvidersSafe,
} from '@/server/system';
import { getEmailStatus } from '@/server/smtp';
import { getLicense } from '@/server/license';
import { AdminPanel } from '@/components/settings/admin-panel';

export const dynamic = 'force-dynamic';

export default async function AdminPanelPage() {
  const me = await requirePermissionPage('system.admin');
  const cfg = loadConfig();
  const [version, health, overview, ai, overrides, email, license] = await Promise.all([
    getVersionInfo(),
    getSystemHealth(),
    getAdminOverview(),
    listAiProvidersSafe(),
    getRuntimeOverrides(),
    getEmailStatus(),
    getLicense(),
  ]);

  // What the deployment is, in one glance — values only, never secrets.
  const readOnlyConfig = [
    { label: 'Public URL', value: cfg.appUrl },
    { label: 'Database', value: cfg.DATABASE_URL ? 'configured' : 'missing' },
    { label: 'Redis', value: cfg.REDIS_URL ? 'configured' : 'missing' },
    { label: 'Attachments (S3)', value: cfg.storageEnabled ? 'configured' : 'not configured' },
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
          The machine room: what this instance is running, who administers it, and whether the
          pieces are alive.
        </p>
      </div>

      <AdminPanel
        version={version}
        health={{
          ...health,
          worker: {
            ...health.worker,
            lastSeenAt: health.worker.lastSeenAt,
          },
        }}
        administrators={overview.administrators.map((a) => ({
          ...a,
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        }))}
        allUsers={overview.allUsers.map((a) => ({
          ...a,
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        }))}
        recentUsers={overview.recent.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        }))}
        currentUserId={me.id}
        canImpersonate={me.permissions.includes('*') || me.permissions.includes('system.impersonate')}
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
        knownModels={KNOWN_MODELS}
        email={email}
        license={license}
        orgName={cfg.appUrl}
      />
    </div>
  );
}
