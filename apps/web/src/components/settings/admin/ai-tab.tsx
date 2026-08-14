'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BarChart3, Bot, Loader2, Plug, Trash2 } from 'lucide-react';
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
  setActiveAiProvider,
  testAiProvider,
} from '@/server/actions/system';
import { cn } from '@/lib/utils';
import { ComingSoon } from './shared';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  custom: 'Custom (OpenAI-compatible)',
};

export interface AiProviderRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  model: string;
  isActive: boolean;
}

export function AiTab({
  providers,
  envAnthropicKey,
  envModel,
  suggestedModels,
  licensed,
}: {
  providers: AiProviderRow[];
  envAnthropicKey: boolean;
  envModel: string;
  suggestedModels: Record<string, string>;
  /** Usage reporting is an enterprise feature; unlicensed instances see the pitch. */
  licensed: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showAdd, setShowAdd] = useState(false);
  const [pName, setPName] = useState('');
  const [pType, setPType] = useState('anthropic');
  const [pKey, setPKey] = useState('');
  const [pModel, setPModel] = useState('');
  const [pBaseUrl, setPBaseUrl] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

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

  const activeProvider = providers.find((x) => x.isActive);

  return (
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
                Answering with <span className="font-semibold">{activeProvider.model}</span> via{' '}
                <span className="font-semibold">{activeProvider.name}</span>.
              </>
            ) : envAnthropicKey ? (
              <>
                Answering with <span className="font-semibold">{envModel}</span> via the
                environment&apos;s <span className="font-mono">ANTHROPIC_API_KEY</span>. Connecting
                a provider here overrides it.
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
                    placeholder={suggestedModels[pType] || 'model id'}
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

          {providers.length === 0 && !showAdd ? (
            <p className="py-2 text-center text-[12.5px] text-muted-foreground">
              No providers connected yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {providers.map((prov) => (
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
                    {testing === prov.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Test'}
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
                        else toast.error(res.error);
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
            rest and never sent to the browser. Anthropic uses its native API; OpenAI, Google, xAI
            and custom providers speak the OpenAI-compatible dialect.
          </p>
        </CardContent>
      </Card>

      {/* ---- Usage ---- */}
      {licensed ? (
        <ComingSoon icon={BarChart3} title="AI usage" badge="Coming soon">
          Token spend per feature, per user and per model — with budgets and alerts. Your licence
          covers this the moment it ships.
        </ComingSoon>
      ) : (
        <ComingSoon icon={BarChart3} title="AI usage" badge="Enterprise">
          Token spend per feature, per user and per model, with budgets and alerts. Requires an
          enterprise licence — see the Enterprise tab. Nothing is being metered today, so no usage
          history is being collected yet.
        </ComingSoon>
      )}
    </div>
  );
}
