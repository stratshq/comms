'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BarChart3, Building2, CheckCircle2, KeyRound, Lock, ShieldCheck, Users2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { removeLicenseKey, saveLicenseKey } from '@/server/actions/system';
import type { LicenseState } from '@/server/license';
import { relativeTime } from '@/lib/format';
import { DataRow } from './shared';

/** What a licence unlocks. Everything here is honestly labelled as not built yet. */
const FEATURES: { icon: React.ElementType; title: string; detail: string }[] = [
  {
    icon: BarChart3,
    title: 'AI usage & cost reporting',
    detail: 'Token spend per feature, per user and per model, with budgets and alerts.',
  },
  {
    icon: ShieldCheck,
    title: 'SSO, SAML & SCIM',
    detail: 'Sign in through your identity provider and provision people automatically.',
  },
  {
    icon: Users2,
    title: 'Advanced audit & retention',
    detail: 'Full audit export, configurable retention windows, and GDPR delete.',
  },
];

export function EnterpriseTab({ license }: { license: LicenseState }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState(license.label ?? '');

  function activate() {
    start(async () => {
      const res = await saveLicenseKey({ key, label });
      if (res.ok) {
        toast.success('Licence activated');
        setKey('');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" />
            Enterprise licence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {license.licensed ? (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted px-3 py-2.5 text-[12.5px] text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-medium">This instance is licensed.</span>
              </div>
              <div className="space-y-1.5">
                {license.label && <DataRow label="Licensed to" value={license.label} />}
                <DataRow
                  label="Key"
                  value={license.keyHint ? `••••••••${license.keyHint}` : 'stored (unreadable)'}
                  mono
                />
                <DataRow
                  label="Activated"
                  value={license.activatedAt ? relativeTime(license.activatedAt) : '—'}
                />
              </div>
              {!license.keyHint && (
                <p className="rounded-lg border border-warning/40 bg-warning-muted px-2.5 py-1.5 text-[11.5px] leading-relaxed text-warning">
                  The stored key cannot be decrypted — this usually means{' '}
                  <span className="font-mono">APP_SECRET</span> changed since it was saved. Enter
                  it again below.
                </p>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await removeLicenseKey();
                    if (res.ok) {
                      toast.success('Licence removed');
                      router.refresh();
                    } else toast.error(res.error);
                  })
                }
              >
                Remove licence
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-lg border bg-surface-sunken px-3 py-2.5 text-[12.5px] text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Enterprise features are locked. If you have a licence key, enter it here to
                  unlock them on this instance.
                </span>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-[12px]">Licence key</Label>
                  <Input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="COMMS-…"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-[12px]">Licensed to (optional)</Label>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Your company"
                  />
                </div>
              </div>
              <Button size="sm" onClick={activate} loading={pending} disabled={key.trim().length < 8}>
                <KeyRound className="mr-1 h-3.5 w-3.5" />
                Activate
              </Button>
            </>
          )}

          <p className="border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Comms is MIT-licensed and self-hosted, so this gate is an honour-system switch rather
            than a cryptographic lock: the key is stored encrypted and unlocks the features below,
            but nothing phones home and nobody is stopped from editing their own database.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What a licence unlocks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                <f.icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[12.5px] font-medium">
                  {f.title}
                  <span className="rounded bg-secondary px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Coming soon
                  </span>
                </span>
                <span className="block text-[11.5px] leading-relaxed text-muted-foreground">
                  {f.detail}
                </span>
              </span>
            </div>
          ))}
          <p className="border-t pt-2.5 text-[11px] text-muted-foreground">
            None of these are built yet. Activating a licence today marks the instance as licensed
            so the features appear the moment they ship.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
