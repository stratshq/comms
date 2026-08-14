'use client';

import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  Globe,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SystemHealth, VersionInfo } from '@/server/system';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DataRow, NeutralDot, StatusDot, fmtBytes, fmtUptime } from './shared';

const STATUS_COPY: Record<
  SystemHealth['status'],
  { label: string; detail: string; className: string }
> = {
  operational: {
    label: 'All systems operational',
    detail: 'Messages are flowing and every dependency is answering.',
    className: 'border-success/30 bg-success-muted text-success',
  },
  degraded: {
    label: 'Degraded',
    detail: 'The app is up, but something that moves messages is not healthy.',
    className: 'border-warning/40 bg-warning-muted text-warning',
  },
  outage: {
    label: 'Outage',
    detail: 'A dependency nothing works without is unreachable.',
    className: 'border-destructive/30 bg-destructive-muted text-destructive',
  },
};

export function HealthTab({
  health,
  version,
}: {
  health: SystemHealth;
  version: VersionInfo;
}) {
  const router = useRouter();
  const status = STATUS_COPY[health.status];

  return (
    <div className="space-y-5">
      {/* ---- Rollup ---- */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-3',
          status.className,
        )}
      >
        {health.status === 'operational' ? (
          <CheckCircle2 className="h-5 w-5 shrink-0" />
        ) : (
          <AlertTriangle className="h-5 w-5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold">{status.label}</p>
          <p className="text-[11.5px] opacity-80">{status.detail}</p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          className="gap-1.5"
          onClick={() => router.refresh()}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </Button>
      </div>

      {/* ---- Core services ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Core services</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <div className="flex items-center gap-2.5 text-sm">
            <StatusDot ok={health.app.ok} />
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Web app</span>
            <span className="text-[12px] text-muted-foreground">
              up {fmtUptime(health.app.uptimeSeconds)} · {health.app.memoryMb} MB ·{' '}
              {health.app.nodeVersion}
            </span>
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <StatusDot ok={health.db.ok} />
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Postgres</span>
            <span className="text-[12px] text-muted-foreground">
              {health.db.ok
                ? `${health.db.latencyMs}ms · ${fmtBytes(health.db.sizeBytes)}`
                : (health.db.error ?? 'unreachable')}
            </span>
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <StatusDot ok={health.redis.ok} />
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Redis</span>
            <span className="text-[12px] text-muted-foreground">
              {health.redis.ok
                ? `${health.redis.latencyMs}ms`
                : (health.redis.error ?? 'unreachable')}
            </span>
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <StatusDot ok={health.worker.ok} />
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1">Worker</span>
            <span className="text-[12px] text-muted-foreground">
              {health.worker.ok
                ? `alive · seen ${health.worker.lastSeenAt ? relativeTime(health.worker.lastSeenAt) : 'now'}`
                : 'no heartbeat — is the worker service running?'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ---- Instance & upgrade status ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Instance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          <div className="space-y-1.5">
            <DataRow
              label="Instance status"
              value={
                <span
                  className={cn(
                    'font-medium',
                    health.status === 'operational'
                      ? 'text-success'
                      : health.status === 'degraded'
                        ? 'text-warning'
                        : 'text-destructive',
                  )}
                >
                  {status.label}
                </span>
              }
            />
            <DataRow
              label="Workspace status"
              value={
                health.db.ok ? (
                  <span className="text-success">Active</span>
                ) : (
                  <span className="text-destructive">Unavailable</span>
                )
              }
            />
            <DataRow label="Running version" value={`v${version.current}`} mono />
            <DataRow
              label="Upgrade status"
              value={
                version.latest == null ? (
                  <span className="text-muted-foreground">{version.note ?? 'unknown'}</span>
                ) : version.upToDate ? (
                  <span className="text-success">On the latest release</span>
                ) : (
                  <a
                    href={version.latestUrl ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-brand hover:underline"
                  >
                    {version.latest} available
                  </a>
                )
              }
            />
          </div>

          {/* Schema state: the quiet failure mode of a partial deploy. */}
          <div className="border-t pt-2.5">
            <div className="flex items-center gap-2.5 text-sm">
              {health.schema.error ? (
                <NeutralDot />
              ) : (
                <StatusDot ok={health.schema.upToDate} />
              )}
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1">Database schema</span>
              <span className="text-[12px] text-muted-foreground">
                {health.schema.error
                  ? 'could not read migration state'
                  : health.schema.upToDate
                    ? `${health.schema.applied} migrations applied`
                    : `${health.schema.pending} migration${health.schema.pending === 1 ? '' : 's'} pending`}
              </span>
            </div>
            {!health.schema.upToDate && !health.schema.error && (
              <p className="mt-1.5 rounded-lg border border-warning/40 bg-warning-muted px-2.5 py-1.5 text-[11.5px] leading-relaxed text-warning">
                This build expects {health.schema.expected} migrations but the database has{' '}
                {health.schema.applied}. Run <span className="font-mono">pnpm db:migrate</span> —
                until then, features using the newest columns will error.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- Queues ---- */}
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
          {health.queues.map((q) => (
            <div key={q.name} className="grid grid-cols-5 gap-1 py-1 text-sm tabular">
              <span className="font-mono text-[12.5px]">{q.name}</span>
              <span className="text-right">{q.waiting < 0 ? '—' : q.waiting}</span>
              <span className="text-right">{q.active < 0 ? '—' : q.active}</span>
              <span className="text-right">{q.delayed < 0 ? '—' : q.delayed}</span>
              <span className={cn('text-right', q.failed > 0 && 'font-semibold text-destructive')}>
                {q.failed < 0 ? '—' : q.failed}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- Bridges ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">iMessage bridges</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {health.bridges.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">No numbers connected yet.</p>
          ) : (
            health.bridges.map((b) => (
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

      {/* ---- Optional services ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Optional services</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            { label: 'Attachment storage (S3)', ok: health.storageConfigured },
            { label: 'Email (SMTP)', ok: health.smtpConfigured },
            { label: 'Voice transcription', ok: health.transcriptionConfigured },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-2.5 text-sm">
              {row.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              ) : (
                <NeutralDot />
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
  );
}
