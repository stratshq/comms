import { requirePermissionPage } from '@/lib/session';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { listInboxes } from '@/server/queries';
import { Button } from '@/components/ui/button';
import { ConnectBlueBubbles } from '@/components/settings/connect-bluebubbles';
import { InboxActions } from '@/components/settings/inbox-actions';
import { getInboxSummary } from '@/server/actions/inboxes';
import { ConnectionCard } from '@/components/settings/connection-card';
import { InboxSettings } from '@/components/settings/inbox-settings';

export const dynamic = 'force-dynamic';

export default async function InboxesSettingsPage() {
  await requirePermissionPage('inboxes.manage');
  const inboxes = await listInboxes();

  // Per-inbox history counts, so a delete can warn about exactly what it costs.
  const summaries = await Promise.all(inboxes.map((i) => getInboxSummary(i.id)));
  const counts = Object.fromEntries(
    summaries.filter((s): s is NonNullable<typeof s> => Boolean(s)).map((s) => [s.id, s]),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Inboxes & Channels</h2>
          <p className="text-sm text-muted-foreground">
            Connect one or more iMessage numbers. Each number becomes its own channel you can
            filter by in the inbox.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/inboxes/setup">
            <Plus className="h-4 w-4" />
            {inboxes.length > 0 ? 'Connect another number' : 'Connect iMessage'}
          </Link>
        </Button>
      </div>

      {inboxes.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-[15px] font-medium">No numbers connected yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Comms connects to iMessage through a Mac you leave running. Our step-by-step guide walks
            you through it — no technical experience needed, about fifteen minutes.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button asChild>
              <Link href="/settings/inboxes/setup">Start the guided setup</Link>
            </Button>
            <ConnectBlueBubbles hasExisting={false} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {inboxes.map((inbox) => (
            <div key={inbox.id} className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{inbox.name}</h3>
                {inbox.isDefault && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                    Default
                  </span>
                )}
                {inbox.connections.length === 0 && (
                  <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning">
                    Not connected
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {counts[inbox.id]?.conversationCount ?? 0} conversation
                  {(counts[inbox.id]?.conversationCount ?? 0) === 1 ? '' : 's'}
                </span>
                <div className="ml-auto">
                  <InboxActions
                    inbox={{
                      id: inbox.id,
                      name: inbox.name,
                      conversationCount: counts[inbox.id]?.conversationCount ?? 0,
                      messageCount: counts[inbox.id]?.messageCount ?? 0,
                      hasConnection: inbox.connections.length > 0,
                    }}
                    otherInboxes={inboxes
                      .filter((o) => o.id !== inbox.id)
                      .map((o) => ({ id: o.id, name: o.name }))}
                  />
                </div>
              </div>
              <InboxSettings inboxId={inbox.id} settings={inbox.settings} />
              {inbox.connections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-warning/40 bg-warning-muted/40 p-3.5 text-sm">
                  <p className="font-medium">This inbox has no channel connected.</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    It usually means the connection was removed. If this is a leftover duplicate,
                    use <strong>Merge into…</strong> to move its conversations into your live inbox,
                    or <strong>Delete inbox</strong> if it&apos;s empty.
                  </p>
                </div>
              ) : (
                inbox.connections.map((c) => (
                  <ConnectionCard
                    key={c.id}
                    connection={{
                      id: c.id,
                      serverUrl: c.serverUrl,
                      status: c.status,
                      privateApi: Boolean(c.capabilities?.privateApi),
                      serverVersion: c.capabilities?.serverVersion,
                      lastError: c.lastError,
                      webhookRegistered: Boolean(c.providerWebhookId),
                    }}
                  />
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
