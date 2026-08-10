'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Eye, RefreshCw, ShieldCheck } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { recheckVersion } from '@/server/actions/system';
import { startImpersonation } from '@/server/actions/impersonation';
import type { VersionInfo } from '@/server/system';
import { relativeTime } from '@/lib/format';
import { cn, initials } from '@/lib/utils';
import { DataRow } from './shared';

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  status: string;
  superAccess: boolean;
  adminPanel: boolean;
  impersonate: boolean;
  viewable: boolean;
  lastSeenAt: string | null;
}

/** A tick or a dash — a dash reads as "no" faster than an empty cell. */
function AccessCell({ on, title }: { on: boolean; title: string }) {
  return (
    <span className="grid w-24 shrink-0 place-items-center" title={title}>
      {on ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      ) : (
        <span className="text-[12px] text-muted-foreground/40">—</span>
      )}
    </span>
  );
}

export function GeneralTab({
  version,
  administrators,
  allUsers,
  recentUsers,
  currentUserId,
  canImpersonate,
  publicUrl,
}: {
  version: VersionInfo;
  administrators: AdminUserRow[];
  allUsers: AdminUserRow[];
  recentUsers: { id: string; name: string | null; email: string; role: string; lastSeenAt: string | null }[];
  currentUserId: string;
  canImpersonate: boolean;
  publicUrl: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [viewTarget, setViewTarget] = useState<AdminUserRow | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  function beginImpersonation(user: AdminUserRow) {
    start(async () => {
      const res = await startImpersonation(user.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setViewTarget(null);
      setPickerOpen(false);
      router.push('/inbox');
      router.refresh();
    });
  }

  const viewableUsers = allUsers.filter((u) => u.viewable && u.id !== currentUserId);

  return (
    <div className="space-y-5">
      {/* ---- About ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-lg bg-secondary px-2.5 py-1 font-mono text-sm font-semibold">
              v{version.current}
            </span>
            {version.latest ? (
              version.upToDate ? (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  Up to date
                </Badge>
              ) : (
                <a
                  href={version.latestUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-brand-muted px-2 py-0.5 text-[12px] font-medium text-brand hover:opacity-80"
                >
                  {version.latest} available →
                </a>
              )
            ) : (
              <span className="text-[12.5px] text-muted-foreground">
                {version.note ?? 'Latest release unknown.'}
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

          <div className="space-y-1.5 border-t pt-3">
            <DataRow label="Running version" value={`v${version.current}`} mono />
            <DataRow label="Latest release" value={version.latest ?? 'unknown'} mono />
            <DataRow label="Public URL" value={publicUrl} mono />
            <DataRow
              label="Last checked"
              value={version.checkedAt ? relativeTime(version.checkedAt) : 'never'}
            />
          </div>
        </CardContent>
      </Card>

      {/* ---- Administrators ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            Administrators
            {canImpersonate && viewableUsers.length > 0 && (
              <Button size="xs" variant="outline" onClick={() => setPickerOpen(true)}>
                <Eye className="mr-1 h-3 w-3" />
                View as a user
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            <span className="min-w-0 flex-1">Person</span>
            <span className="w-24 shrink-0 text-center">Super</span>
            <span className="w-24 shrink-0 text-center">Admin panel</span>
            <span className="w-24 shrink-0 text-center">View as</span>
          </div>

          {administrators.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">
              Nobody has elevated access yet.
            </p>
          ) : (
            administrators.map((a) => (
              <div key={a.id} className="flex items-center gap-2">
                <Avatar className="h-7 w-7 shrink-0">
                  {a.image && <AvatarImage src={a.image} alt="" />}
                  <AvatarFallback className="bg-secondary text-[10px] font-semibold">
                    {initials(a.name ?? a.email)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-sm">
                    {a.name ?? a.email}
                    {a.superAccess && <ShieldCheck className="h-3 w-3 shrink-0 text-brand" />}
                    {a.id === currentUserId && (
                      <span className="text-[11px] text-muted-foreground">(you)</span>
                    )}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {a.role}
                  </span>
                </span>
                <AccessCell on={a.superAccess} title="Every permission, including future ones" />
                <AccessCell on={a.adminPanel} title="Can open this admin panel" />
                <AccessCell on={a.impersonate} title="Can view the app as another user" />
              </div>
            ))
          )}

          <p className="border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            These columns come from each person&apos;s role — change them in{' '}
            <span className="font-medium">Settings → Roles</span>. A super account holds every
            permission, including ones added in later versions, and cannot be viewed as.
          </p>
        </CardContent>
      </Card>

      {/* ---- Recently active ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recently active</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {recentUsers.map((u) => (
            <div key={u.id} className="flex items-center gap-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{u.name ?? u.email}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{u.role}</span>
              <span className="w-24 shrink-0 text-right text-[11.5px] text-muted-foreground">
                {u.lastSeenAt ? relativeTime(u.lastSeenAt) : 'never'}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- View-as picker ---- */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>View as a user</DialogTitle>
          </DialogHeader>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            You will see the app exactly as they do — their inbox, folders and permissions — in{' '}
            <span className="font-medium text-foreground">read-only</span> mode. Nothing can be
            sent or changed while viewing, and both the start and the end are recorded.
          </p>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {viewableUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={pending}
                onClick={() => setViewTarget(u)}
                className="flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-accent disabled:opacity-60"
              >
                <Avatar className="h-7 w-7 shrink-0">
                  {u.image && <AvatarImage src={u.image} alt="" />}
                  <AvatarFallback className="bg-secondary text-[10px] font-semibold">
                    {initials(u.name ?? u.email)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {u.name ?? u.email}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {u.email} · {u.role}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- Confirm ---- */}
      <Dialog open={Boolean(viewTarget)} onOpenChange={(o) => !o && setViewTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>View as {viewTarget?.name ?? viewTarget?.email}?</DialogTitle>
          </DialogHeader>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            A banner stays on screen until you stop. This is recorded in the audit log against your
            account.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewTarget(null)}>
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={() => viewTarget && beginImpersonation(viewTarget)}
            >
              <Eye className="mr-1 h-3.5 w-3.5" />
              Start viewing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
