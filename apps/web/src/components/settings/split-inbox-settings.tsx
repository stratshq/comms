'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bot, KeyRound, UserRound } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { setSplitInboxFolder } from '@/server/actions/views';

const SECTIONS = [
  {
    kind: 'otp',
    label: 'Verification codes',
    hint: '2FA and login codes, with a copy-the-code chip on each row.',
    icon: KeyRound,
  },
  {
    kind: 'automated',
    label: 'Automated',
    hint: 'Delivery notices, appointment reminders, one-way alerts.',
    icon: Bot,
  },
  {
    kind: 'unknown',
    label: 'Unknown numbers',
    hint: 'Numbers nobody has named yet — the ones worth screening.',
    icon: UserRound,
  },
] as const;

/**
 * The split inbox, as three switches. Each one IS a shared folder — on
 * creates it, off deletes it — so this card and the inbox can never tell
 * different stories about what's grouped.
 */
export function SplitInboxSettings({ state }: { state: Record<string, boolean> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(state);

  function toggle(kind: string, enabled: boolean) {
    setLocal((s) => ({ ...s, [kind]: enabled }));
    start(async () => {
      const res = await setSplitInboxFolder(kind, enabled);
      if (!res.ok) {
        setLocal((s) => ({ ...s, [kind]: !enabled }));
        toast.error(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {SECTIONS.map((s) => (
        <div key={s.kind} className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </div>
          </div>
          <Switch
            checked={Boolean(local[s.kind])}
            disabled={pending}
            onCheckedChange={(v) => toggle(s.kind, v)}
          />
        </div>
      ))}
      <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
        Each section is a shared folder: machine traffic groups under its own header in the inbox
        and in the sidebar, so the main stream is people. Classification comes from the traffic
        itself, and a thread anyone replies to always counts as a person.
      </p>
    </div>
  );
}
