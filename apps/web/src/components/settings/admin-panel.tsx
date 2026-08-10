'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, Blocks, Building2, Info, Settings2, Sparkles } from 'lucide-react';
import type { SystemHealth, VersionInfo } from '@/server/system';
import type { EmailStatus } from '@/server/smtp';
import type { LicenseState } from '@/server/license';
import { GeneralTab, type AdminUserRow } from '@/components/settings/admin/general-tab';
import { AiTab, type AiProviderRow } from '@/components/settings/admin/ai-tab';
import { ConfigTab } from '@/components/settings/admin/config-tab';
import { HealthTab } from '@/components/settings/admin/health-tab';
import { EnterpriseTab } from '@/components/settings/admin/enterprise-tab';
import { ComingSoon } from '@/components/settings/admin/shared';
import { cn } from '@/lib/utils';

/**
 * The instance's own control panel: what this build is, who administers it,
 * which model answers, which knobs are turned, whether the pieces are alive,
 * and what a licence would unlock. Workspace content (tags, macros, roles)
 * stays in its own pages — this is the machine room.
 */

const TABS = [
  { key: 'general', label: 'General', icon: Info },
  { key: 'apps', label: 'Apps', icon: Blocks },
  { key: 'ai', label: 'AI', icon: Sparkles },
  { key: 'config', label: 'Config', icon: Settings2 },
  { key: 'health', label: 'Health', icon: Activity },
  { key: 'enterprise', label: 'Enterprise', icon: Building2 },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export interface AdminPanelProps {
  version: VersionInfo;
  health: SystemHealth;
  administrators: AdminUserRow[];
  allUsers: AdminUserRow[];
  recentUsers: {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    lastSeenAt: string | null;
  }[];
  currentUserId: string;
  canImpersonate: boolean;
  providers: AiProviderRow[];
  envAnthropicKey: boolean;
  envModel: string;
  overrides: {
    undoSendSeconds?: number;
    sendHourlyCap?: number;
    sendDailyCap?: number;
    sendMinIntervalMs?: number;
  };
  envDefaults: {
    undoSendSeconds: number;
    sendHourlyCap: number;
    sendDailyCap: number;
    sendMinIntervalMs: number;
  };
  readOnlyConfig: { label: string; value: string; hint?: string }[];
  suggestedModels: Record<string, string>;
  email: EmailStatus;
  license: LicenseState;
  /** The instance's public URL, shown in About. */
  orgName: string;
}

export function AdminPanel(p: AdminPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The tab lives in the URL so "look at the Health tab" is a link you can
  // send, and a refresh after saving keeps you where you were.
  const requested = searchParams.get('tab');
  const tab: TabKey = (TABS.find((t) => t.key === requested)?.key ?? 'general') as TabKey;

  function setTab(next: TabKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'general') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `/settings/admin?${qs}` : '/settings/admin', { scroll: false });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-0.5 overflow-x-auto rounded-xl bg-secondary/60 p-[3px] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn(
              'flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === t.key
                ? 'bg-surface text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <GeneralTab
          version={p.version}
          administrators={p.administrators}
          allUsers={p.allUsers}
          recentUsers={p.recentUsers}
          currentUserId={p.currentUserId}
          canImpersonate={p.canImpersonate}
          publicUrl={p.orgName}
        />
      )}

      {tab === 'apps' && (
        <ComingSoon icon={Blocks} title="Apps" badge="Coming soon">
          A catalogue of apps that extend Comms: Stripe, Shopify and your CRM in the contact panel,
          reply-from-Slack, and outbound webhooks. Install, configure and remove them from here.
        </ComingSoon>
      )}

      {tab === 'ai' && (
        <AiTab
          providers={p.providers}
          envAnthropicKey={p.envAnthropicKey}
          envModel={p.envModel}
          suggestedModels={p.suggestedModels}
          licensed={p.license.licensed}
        />
      )}

      {tab === 'config' && (
        <ConfigTab
          overrides={p.overrides}
          envDefaults={p.envDefaults}
          readOnlyConfig={p.readOnlyConfig}
          email={p.email}
        />
      )}

      {tab === 'health' && <HealthTab health={p.health} version={p.version} />}

      {tab === 'enterprise' && <EnterpriseTab license={p.license} />}
    </div>
  );
}
