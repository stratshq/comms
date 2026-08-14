'use client';

import { CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Green tick / red cross for a binary "is this alive" signal. */
export function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
  );
}

/** A hollow dot for "not configured", which is not a failure. */
export function NeutralDot() {
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
    </span>
  );
}

export function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/**
 * The house empty state for a feature that doesn't exist yet. Says what it
 * will be and why it isn't here, rather than a bare "coming soon" that reads
 * as an unfinished screen.
 */
export function ComingSoon({
  icon: Icon,
  title,
  children,
  badge,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="flex items-center justify-center gap-2 text-sm font-semibold">
            {title}
            {badge && (
              <span className="rounded bg-brand-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand">
                {badge}
              </span>
            )}
          </p>
          <div className="mx-auto mt-1 max-w-[420px] text-xs leading-relaxed text-muted-foreground">
            {children}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Label/value row used by the config and health readouts. */
export function DataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-40 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}
