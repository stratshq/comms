'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Activity,
  Blocks,
  Bot,
  CheckCircle2,
  Database,
  Info,
  Loader2,
  Plug,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  addAiProvider,
  deleteAiProvider,
  recheckVersion,
  saveRuntimeOverrides,
  setActiveAiProvider,
  testAiProvider,
} from '@/server/actions/system';
import type { SystemHealth, VersionInfo } from '@/server/system';
import { relativeTime } from '@/lib/format';
import { cn, initials } from '@/lib/utils';

/**
 * The instance's own control panel: what version is running, who runs it,
 * which model answers, which knobs are turned, and whether the pieces are
 * alive. Workspace content (tags, macros, teams) stays in its own pages —
 * this is the machine room.
 */

type TabKey = 'general' | 'apps' | 'ai' | 'config' | 'health';

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: 'general', label: 'General', icon: Info },
  { key: 'apps', label: 'Apps', icon: Blocks },
  { key: 'ai', label: 'AI', icon: Sparkles },
  { key: 'config', label: 'Config', icon: Settings2 },
  { key: 'health', label: 'Health', icon: Activity },
];

export interface AdminPanelProps {
  version: VersionInfo;
  health: SystemHealth;
  admins: { id: string; name: string | null; email: string; role: string; image: string | null }[];
  recentUsers: {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    lastSeenAt: string | null;
  }[];
  providers: {
    id: string;
    name: string;
    type: string;
    baseUrl: string | null;
    model: string;
    isActive: boolean;
  }[];
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
}

function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
  );
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  custom: 'Custom (OpenAI-compatible)',
};

export function AdminPanel(p: AdminPanelProps) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('general');
  const [pending, start] = useTransition();

  // ---- AI tab state ----
  const [showAdd, setShowAdd] = useState(false);
  const [pName, setPName] = useState('');
  const [pType, setPType] = useState('anthropic');
  const [pKey, setPKey] = useState('');
  const [pModel, setPModel] = useState('');
  const [pBaseUrl, setPBaseUrl] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  // ---- Config tab state ----
  const [undoSecs, setUndoSecs] = useState(String(p.overrides.undoSendSeconds ?? ''));
  const [hourly, setHourly] = useState(String(p.overrides.sendHourlyCap ?? ''));
  const [daily, setDaily] = useState(String(p.overrides.sendDailyCap ?? ''));
  const [interval, setIntervalMs] = useState(String(p.overrides.sendMinIntervalMs ?? ''));

  function addProvider() {
    start(async () => {
      const res = await addAiProvider({
        name: pName,
        type: pType,
        apiKey: pKey,
        model: pModel,
        baseUrl: pBaseUrl || undefined,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${pName.trim()} connected`);
      setShowAdd(false);
      setPName('');
      setPKey('');
      setPModel('');
      setPBaseUrl('');
      router.refresh();
    });
  }

  function test(id: string, name: string) {
    setTesting(id);
    void testAiProvider(id)
      .then((res) => {
        if (res.ok) toast.success(`${name} answered in ${res.latencyMs}ms`);
        else toast.error(`${name}: ${res.error}`);
      })
      .finally(() => setTesting(null));
  }

  function saveConfig() {
    start(async () => {
      const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
      const res = await saveRuntimeOverrides({
        undoSendSeconds: num(undoSecs),
        sendHourlyCap: num(hourly),
        sendDailyCap: num(daily),
        sendMinIntervalMs: num(interval),
      });
      if (res.ok) {
        toast.success('Saved — applies within seconds, no redeploy');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const activeProvider = p.providers.find((x) => x.isActive);

  return (
    <div className="space-y-5">
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 rounded-xl bg-secondary/60 p-[3px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium transition-colors',
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

      {/* ---------------- General ---------------- */}
      {tab === 'general' && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Version</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-lg bg-secondary px-2.5 py-1 font-mono text-sm font-semibold">
                  v{p.version.current}
                </span>
                {p.version.latest ? (
                  p.version.upToDate ? (
                    <Badge variant="secondary" className="gap-1">
                      <CheckCircle2 className="h-3 w-3 text-success" />
                      Up to date
                    </Badge>
                  ) : (
                    <a
                      href={p.version.latestUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md bg-brand-muted px-2 py-0.5 text-[12px] font-medium text-brand hover:opacity-80"
                    >
                      {p.version.latest} available →
                    </a>
                  )
                ) : (
                  <span className="text-[12.5px] text-muted-foreground">
                    {p.version.note ?? 'Latest release unknown.'}
                  </span>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto gap-1.5"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await recheckVersion();
                      router.refresh();
                    })
                  }
                >
                  <RefreshCw className={cn('h-3 w-3', pending && 'animate-spin')} />
                  Check now
                </Button>
              </div>
              {p.version.checkedAt && (
                <p className="text-[11px] text-muted-foreground">
                  Last checked {relativeTime(p.version.checkedAt)}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Administrators</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {p.admins.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5">
                  <Avatar className="h-7 w-7">
                    {a.image && <AvatarImage src={a.image} alt="" />}
                    <AvatarFallback className="bg-secondary text-[10px] font-semibold">
                      {initials(a.name ?? a.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name ?? a.email}</span>
                  <Badge variant="secondary" className="capitalize">
                    {a.role}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recently active</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {p.recentUsers.map((u) => (
                <div key={u.id} className="flex items-center gap-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{u.name ?? u.email}</span>
                  <span className="shrink-0 text-[11.5px] capitalize text-muted-foreground">
                    {u.role}
                  </span>
                  <span className="w-24 shrink-0 text-right text-[11.5px] text-muted-foreground">
                    {u.lastSeenAt ? relativeTime(u.lastSeenAt) : 'never'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------------- Apps ---------------- */}
      {tab === 'apps' && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-muted-foreground">
              <Blocks className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">Apps — coming soon</p>
              <p className="mx-auto mt-1 max-w-[380px] text-xs leading-relaxed text-muted-foreground">
                Sidebar apps that bring Stripe, Shopify and your CRM into the contact panel, plus
                reply-from-Slack. Tracked on the roadmap as the platform wave.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------------- AI ---------------- */}
      {tab === 'ai' && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Model providers
                <Button size="xs" variant="outline" onClick={() => setShowAdd((s) => !s)}>
                  <Plug className="mr-1 h-3 w-3" />
                  Connect provider
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Effective state, stated plainly. */}
              <div className="rounded-lg border bg-surface-sunken px-3 py-2.5 text-[12.5px]">
                {activeProvider ? (
                  <>
                    Answering with{' '}
                    <span className="font-semibold">{activeProvider.model}</span> via{' '}
                    <span className="font-semibold">{activeProvider.name}</span>.
                  </>
                ) : p.envAnthropicKey ? (
                  <>
                    Answering with <span className="font-semibold">{p.envModel}</span> via the
                    environment&apos;s <span className="font-mono">ANTHROPIC_API_KEY</span>.
                    Connecting a provider here overrides it.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">AI is off.</span> Connect a provider to enable
                    summaries, drafts, triage, bundles and Ask.
                  </>
                )}
              </div>

              {showAdd && (
                <div className="space-y-3 rounded-lg border bg-surface-sunken p-3">
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-[12px]">Provider</Label>
                      <Select
                        value={pType}
                        onValueChange={(v) => {
                          setPType(v);
                          setPModel('');
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(PROVIDER_LABELS).map(([k, label]) => (
                            <SelectItem key={k} value={k}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[12px]">Name</Label>
                      <Input
                        value={pName}
                        onChange={(e) => setPName(e.target.value)}
                        placeholder={`${PROVIDER_LABELS[pType]} production`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[12px]">API key</Label>
                      <Input
                        type="password"
                        value={pKey}
                        onChange={(e) => setPKey(e.target.value)}
                        placeholder="Stored encrypted with the app secret"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[12px]">Model</Label>
                      <Input
                        value={pModel}
                        onChange={(e) => setPModel(e.target.value)}
                        placeholder={p.suggestedModels[pType] || 'model id'}
                      />
                    </div>
                    {pType === 'custom' && (
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-[12px]">Base URL (OpenAI-compatible)</Label>
                        <Input
                          value={pBaseUrl}
                          onChange={(e) => setPBaseUrl(e.target.value)}
                          placeholder="https://my-host/v1 — Ollama, vLLM, OpenRouter…"
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={addProvider}
                      loading={pending}
                      disabled={!pName.trim() || !pKey.trim() || !pModel.trim()}
                    >
                      Connect
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {p.providers.length === 0 && !showAdd ? (
                <p className="py-2 text-center text-[12.5px] text-muted-foreground">
                  No providers connected yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {p.providers.map((prov) => (
                    <div
                      key={prov.id}
                      className={cn(
                        'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2',
                        prov.isActive && 'border-brand/40 bg-brand-muted/40',
                      )}
                    >
                      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {prov.name}
                          {prov.isActive && (
                            <span className="ml-2 rounded bg-brand px-1.5 py-px text-[10px] font-semibold text-brand-foreground">
                              ACTIVE
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {PROVIDER_LABELS[prov.type]} · {prov.model}
                          {prov.baseUrl ? ` · ${prov.baseUrl}` : ''}
                        </span>
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={testing === prov.id}
                        onClick={() => test(prov.id, prov.name)}
                      >
                        {testing === prov.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'Test'
                        )}
                      </Button>
                      {prov.isActive ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending}
                          onClick={() =>
                            start(async () => {
                              await setActiveAiProvider(null);
                              router.refresh();
                            })
                          }
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            start(async () => {
                              await setActiveAiProvider(prov.id);
                              router.refresh();
                            })
                          }
                        >
                          Make active
                        </Button>
                      )}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const res = await deleteAiProvider(prov.id);
                            if (res.ok) toast.success(`${prov.name} removed`);
                            router.refresh();
                          })
                        }
                        aria-label={`Remove ${prov.name}`}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive-muted hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                One provider is active at a time and serves every AI feature. Keys are encrypted at
                rest and never sent to the browser. Anthropic uses its native API; OpenAI, Google,
                xAI and custom providers speak the OpenAI-compatible dialect.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------------- Config ---------------- */}
      {tab === 'config' && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Runtime settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[12px] text-muted-foreground">
                Applied within seconds, no redeploy. Blank means &ldquo;use the environment
                default&rdquo; (shown in each placeholder).
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Undo-send window (seconds)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={undoSecs}
                    onChange={(e) => setUndoSecs(e.target.value)}
                    placeholder={String(p.envDefaults.undoSendSeconds)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Min. pause between sends (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={60000}
                    value={interval}
                    onChange={(e) => setIntervalMs(e.target.value)}
                    placeholder={String(p.envDefaults.sendMinIntervalMs)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Hourly send cap (per number)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={hourly}
                    onChange={(e) => setHourly(e.target.value)}
                    placeholder={String(p.envDefaults.sendHourlyCap)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12px]">Daily send cap (per number)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    value={daily}
                    onChange={(e) => setDaily(e.target.value)}
                    placeholder={String(p.envDefaults.sendDailyCap)}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The send caps exist to protect the Apple ID from carrier throttling — raise them
                gently.
              </p>
              <Button size="sm" onClick={saveConfig} loading={pending}>
                Save runtime settings
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deployment configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {p.readOnlyConfig.map((row) => (
                <div key={row.label} className="flex items-baseline gap-3 text-sm">
                  <span className="w-40 shrink-0 text-[12.5px] text-muted-foreground">
                    {row.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {row.value}
                  </span>
                </div>
              ))}
              <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
                These come from the deployment&apos;s environment variables (Railway → service →
                Variables) and require a redeploy to change — a page that pretended otherwise would
                be lying about when the change applies.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------------- Health ---------------- */}
      {tab === 'health' && (
        <div className="space-y-5">
          <div className="flex justify-end">
            <Button size="xs" variant="ghost" className="gap-1.5" onClick={() => router.refresh()}>
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Core services</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex items-center gap-2.5 text-sm">
                <StatusDot ok={p.health.db.ok} />
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1">Postgres</span>
                <span className="text-[12px] text-muted-foreground">
                  {p.health.db.ok
                    ? `${p.health.db.latencyMs}ms · ${fmtBytes(p.health.db.sizeBytes)}`
                    : (p.health.db.error ?? 'unreachable')}
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-sm">
                <StatusDot ok={p.health.redis.ok} />
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1">Redis</span>
                <span className="text-[12px] text-muted-foreground">
                  {p.health.redis.ok
                    ? `${p.health.redis.latencyMs}ms`
                    : (p.health.redis.error ?? 'unreachable')}
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-sm">
                <StatusDot ok={p.health.worker.ok} />
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1">Worker</span>
                <span className="text-[12px] text-muted-foreground">
                  {p.health.worker.ok
                    ? `alive · seen ${p.health.worker.lastSeenAt ? relativeTime(p.health.worker.lastSeenAt) : 'now'}`
                    : 'no heartbeat — is the worker service running?'}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Queues</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-5 gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                <span>Queue</span>
                <span className="text-right">Waiting</span>
                <span className="text-right">Active</span>
                <span className="text-right">Delayed</span>
                <span className="text-right">Failed</span>
              </div>
              {p.health.queues.map((q) => (
                <div key={q.name} className="grid grid-cols-5 gap-1 py-1 text-sm tabular">
                  <span className="font-mono text-[12.5px]">{q.name}</span>
                  <span className="text-right">{q.waiting < 0 ? '—' : q.waiting}</span>
                  <span className="text-right">{q.active < 0 ? '—' : q.active}</span>
                  <span className="text-right">{q.delayed < 0 ? '—' : q.delayed}</span>
                  <span
                    className={cn('text-right', q.failed > 0 && 'font-semibold text-destructive')}
                  >
                    {q.failed < 0 ? '—' : q.failed}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">iMessage bridges</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {p.health.bridges.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">No numbers connected yet.</p>
              ) : (
                p.health.bridges.map((b) => (
                  <div key={b.inboxName} className="flex items-center gap-2.5 text-sm">
                    <StatusDot ok={b.status === 'connected'} />
                    <span className="flex-1">{b.inboxName}</span>
                    <span className="text-[12px] capitalize text-muted-foreground">
                      {b.status}
                      {b.lastHeartbeatAt ? ` · ${relativeTime(b.lastHeartbeatAt)}` : ''}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Optional services</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {[
                { label: 'Attachment storage (S3)', ok: p.health.storageConfigured },
                { label: 'Email (SMTP)', ok: p.health.smtpConfigured },
                { label: 'Voice transcription', ok: p.health.transcriptionConfigured },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2.5 text-sm">
                  {row.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  ) : (
                    <span className="grid h-4 w-4 shrink-0 place-items-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    </span>
                  )}
                  <span className="flex-1">{row.label}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {row.ok ? 'configured' : 'not configured'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
