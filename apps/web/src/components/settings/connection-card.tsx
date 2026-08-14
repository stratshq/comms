'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCw, Webhook, Trash2, CheckCircle2, XCircle, Pencil, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { relativeTime } from '@/lib/format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  testConnection,
  reRegisterWebhook,
  disconnect,
  updateConnectionServerUrl,
  syncContactsNow,
} from '@/server/actions/connections';

export interface ContactSyncSummary {
  at: string;
  fetched: number;
  created: number;
  enriched: number;
  avatarsStored: number;
  reclassified: number;
  macContactsVisible: boolean;
}

export function ConnectionCard({
  connection,
  lastContactSync = null,
}: {
  connection: {
    id: string;
    serverUrl: string;
    status: string;
    privateApi: boolean;
    serverVersion?: string;
    lastError?: string | null;
    webhookRegistered: boolean;
  };
  /** What the last contact sync actually did. Null before the first run. */
  lastContactSync?: ContactSyncSummary | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [newUrl, setNewUrl] = useState(connection.serverUrl);
  const [newPassword, setNewPassword] = useState('');

  const connected = connection.status === 'connected';

  function saveUrl() {
    start(async () => {
      const res = await updateConnectionServerUrl({
        connectionId: connection.id,
        serverUrl: newUrl,
        password: newPassword || undefined,
      });
      if (res.ok) {
        toast.success(
          res.webhookRegistered
            ? 'Server URL updated — webhook re-registered, backfilling missed messages.'
            : 'Server URL updated, but the webhook could not be registered. Use "Re-register webhook".',
        );
        setEditOpen(false);
        setNewPassword('');
        router.refresh();
      } else {
        toast.error(res.error ?? 'Failed to update the server URL.');
      }
    });
  }

  return (
    <div className="rounded-xl border bg-surface p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {connected ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 text-destructive" />
            )}
            <span className="truncate font-mono text-[12.5px] font-medium">
              {connection.serverUrl}
            </span>
            <button
              type="button"
              onClick={() => {
                setNewUrl(connection.serverUrl);
                setEditOpen(true);
              }}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Update server URL"
              aria-label="Update server URL"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge
              variant={connected ? 'soft-success' : 'soft-danger'}
              size="sm"
              className="capitalize"
            >
              {connection.status}
            </Badge>
            <Badge variant={connection.privateApi ? 'soft-brand' : 'secondary'} size="sm">
              {connection.privateApi ? 'Private API' : 'Basic mode'}
            </Badge>
            {connection.serverVersion && (
              <Badge variant="outline" size="sm">
                v{connection.serverVersion}
              </Badge>
            )}
            <Badge variant={connection.webhookRegistered ? 'outline' : 'soft-danger'} size="sm">
              {connection.webhookRegistered ? 'Webhook active' : 'Webhook missing'}
            </Badge>
          </div>
          {connection.lastError && (
            <p className="mt-2 text-xs text-destructive">{connection.lastError}</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await testConnection(connection.id);
              if (res.ok) toast.success('Connection healthy');
              else toast.error(res.error ?? 'Connection failed');
              router.refresh();
            })
          }
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Test
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await reRegisterWebhook(connection.id);
              if (res.ok) toast.success('Webhook re-registered');
              else toast.error(res.error ?? 'Failed');
              router.refresh();
            })
          }
        >
          <Webhook className="h-3.5 w-3.5" />
          Re-register webhook
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await syncContactsNow(connection.id);
              if (res.ok)
                toast.success('Syncing contacts from your Mac — names appear within a minute.');
              else toast.error(res.error ?? 'Failed');
            })
          }
        >
          <Users className="h-3.5 w-3.5" />
          Sync contacts
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await disconnect(connection.id);
              toast.success('Disconnected');
              router.refresh();
            })
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
          Disconnect
        </Button>
      </div>

      {/* What the last sync actually did. The counts were computed and thrown
          away before this, so "no names, no faces" had no explanation to
          find — in particular a Mac that never granted Contacts permission
          returns a roster with no photos in it and no error. */}
      {lastContactSync && (
        <div className="mt-3 rounded-lg border bg-secondary/40 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">
            Last contact sync {relativeTime(lastContactSync.at)}
          </span>
          {' — '}
          {lastContactSync.fetched.toLocaleString()} from the Mac,{' '}
          {lastContactSync.created.toLocaleString()} new,{' '}
          {lastContactSync.enriched.toLocaleString()} updated,{' '}
          {lastContactSync.avatarsStored.toLocaleString()} photo
          {lastContactSync.avatarsStored === 1 ? '' : 's'}.
          {lastContactSync.reclassified > 0 && (
            <>
              {' '}
              {lastContactSync.reclassified.toLocaleString()} moved out of Unknown.
            </>
          )}
          {!lastContactSync.macContactsVisible && (
            <span className="mt-1 block text-warning">
              No macOS Contacts records came back — BlueBubbles is running without Contacts
              permission, so names and photos from your address book can&rsquo;t reach Comms.
              Grant it in System Settings → Privacy &amp; Security → Contacts, then sync again.
            </span>
          )}
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update server URL</DialogTitle>
            <DialogDescription>
              Moved or restarted your BlueBubbles tunnel? Paste the new address here. Your inbox,
              conversations, and history all stay exactly where they are — only the address changes,
              and any messages missed while the old address was dead are backfilled automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="new-url" className="text-[12.5px]">
                New server URL
              </Label>
              <Input
                id="new-url"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://your-tunnel.trycloudflare.com"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password" className="text-[12.5px]">
                Password{' '}
                <span className="font-normal text-muted-foreground">
                  — leave blank to keep the current one
                </span>
              </Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="brand" onClick={saveUrl} loading={pending} disabled={!newUrl.trim()}>
              Verify &amp; update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
