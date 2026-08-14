'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Mail, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  clearEmailSettings,
  saveEmailSettings,
  saveRuntimeOverrides,
  sendTestEmail,
} from '@/server/actions/system';
import type { EmailStatus } from '@/server/smtp';
import { DataRow } from './shared';

export function ConfigTab({
  overrides,
  envDefaults,
  readOnlyConfig,
  email,
}: {
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
  email: EmailStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // Runtime knobs
  const [undoSecs, setUndoSecs] = useState(String(overrides.undoSendSeconds ?? ''));
  const [hourly, setHourly] = useState(String(overrides.sendHourlyCap ?? ''));
  const [daily, setDaily] = useState(String(overrides.sendDailyCap ?? ''));
  const [interval, setIntervalMs] = useState(String(overrides.sendMinIntervalMs ?? ''));

  // Email settings — seeded from whatever is effective today.
  const [host, setHost] = useState(email.settings?.host ?? '');
  const [port, setPort] = useState(String(email.settings?.port ?? 587));
  const [smtpUser, setSmtpUser] = useState(email.settings?.user ?? '');
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(email.settings?.from ?? '');
  const [testTo, setTestTo] = useState('');

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

  function saveEmail() {
    start(async () => {
      const res = await saveEmailSettings({
        host,
        port: Number(port),
        user: smtpUser,
        // An untouched field keeps the stored password rather than wiping it.
        password: password === '' ? undefined : password,
        from,
      });
      if (res.ok) {
        toast.success('Email settings saved');
        setPassword('');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function test() {
    start(async () => {
      const res = await sendTestEmail(testTo);
      if (res.ok) toast.success(`Test message sent to ${testTo}`);
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-5">
      {/* ---- Email ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            Email
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border bg-surface-sunken px-3 py-2.5 text-[12.5px]">
            {email.source === 'database' ? (
              <>
                Using settings saved <span className="font-semibold">here</span>. They override the
                deployment&apos;s environment variables.
              </>
            ) : email.source === 'environment' ? (
              <>
                Using the deployment&apos;s <span className="font-mono">SMTP_*</span> environment
                variables. Saving below overrides them without a redeploy.
              </>
            ) : (
              <>
                <span className="font-semibold">Email is off.</span> Invites and notifications
                cannot be sent until this is configured.
              </>
            )}
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[12px]">SMTP host</Label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.postmarkapp.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px]">Port</Label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="587"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px]">Username</Label>
              <Input
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px]">Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  email.settings?.hasPassword ? 'unchanged — type to replace' : 'stored encrypted'
                }
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-[12px]">From address</Label>
              <Input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="Comms <support@yourcompany.com>"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveEmail} loading={pending} disabled={!host.trim() || !from.trim()}>
              Save email settings
            </Button>
            {email.source === 'database' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await clearEmailSettings();
                    if (res.ok) {
                      toast.success('Reverted to the environment variables');
                      router.refresh();
                    } else toast.error(res.error);
                  })
                }
              >
                Revert to environment
              </Button>
            )}
          </div>

          {email.configured && (
            <div className="space-y-1.5 border-t pt-3">
              <Label className="text-[12px]">Send a test message</Label>
              <div className="flex gap-2">
                <Input
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@yourcompany.com"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && testTo.includes('@')) test();
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={test}
                  loading={pending}
                  disabled={!testTo.includes('@')}
                >
                  <Send className="mr-1 h-3 w-3" />
                  Send
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Actually delivers a message — the only test that proves a mailbox will accept mail
                from this instance.
              </p>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            These settings apply immediately to mail the app sends itself: invites, notifications
            and the test above. Magic-link <span className="font-medium">sign-in</span> is wired
            into the auth layer, which reads its providers once at startup — it picks these up on
            the next restart.
          </p>
        </CardContent>
      </Card>

      {/* ---- Runtime settings ---- */}
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
                placeholder={String(envDefaults.undoSendSeconds)}
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
                placeholder={String(envDefaults.sendMinIntervalMs)}
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
                placeholder={String(envDefaults.sendHourlyCap)}
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
                placeholder={String(envDefaults.sendDailyCap)}
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

      {/* ---- Deployment ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployment configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {readOnlyConfig.map((row) => (
            <DataRow key={row.label} label={row.label} value={row.value} mono />
          ))}
          <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
            These come from the deployment&apos;s environment variables (Railway → service →
            Variables) and require a redeploy to change — a page that pretended otherwise would be
            lying about when the change applies.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
