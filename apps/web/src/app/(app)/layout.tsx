import { can, requireDbUser } from '@/lib/session';
import {
  inboxCounts,
  listInboxes,
  listUnhealthyConnections,
  listSavedViews,
  listTags,
} from '@/server/queries';
import { Sidebar } from '@/components/app/sidebar';
import { RealtimeProvider } from '@/components/app/realtime-provider';
import { ChannelHealthBanner } from '@/components/app/channel-health-banner';
import { ImpersonationBanner } from '@/components/app/impersonation-banner';
import { CommandPalette } from '@/components/app/command-palette';
import { pendingCount } from '@/server/actions/scheduled';
import { KeymapProvider } from '@/components/app/keymap-provider';
import { KeyboardShortcuts } from '@/components/app/keyboard-shortcuts';
import { NewConversation } from '@/components/inbox/new-conversation';
import { MobileTopBar, SidebarShell } from '@/components/app/mobile-shell';
import type { KeymapPreference } from '@/lib/keymap';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Read the row rather than the JWT: the token snapshots name/image/role at
  // sign-in, so a profile edit would otherwise not show up until the next login.
  const user = await requireDbUser();
  const [counts, inboxRows, unhealthy, viewRows, tagRows, pending] = await Promise.all([
    inboxCounts(user.id),
    listInboxes(),
    listUnhealthyConnections(),
    listSavedViews(user.id),
    listTags(),
    pendingCount(),
  ]);

  /**
   * Turn a folder's stored filters back into an inbox URL. Every field the
   * filter bar understands has to appear here, or clicking the folder shows a
   * different set than its badge counted.
   */
  const viewHref = (f: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (f.status && f.status !== 'active') p.set('status', String(f.status));
    if (f.assignee) p.set('assignee', String(f.assignee));
    if (f.kind) p.set('kind', String(f.kind));
    if (f.has) p.set('has', String(f.has));
    if (Array.isArray(f.bodyContains) && f.bodyContains.length)
      p.set('words', f.bodyContains.join(','));
    if (f.inboxId) p.set('inbox', String(f.inboxId));
    if (Array.isArray(f.tagIds) && f.tagIds.length) p.set('tags', f.tagIds.join(','));
    if (Array.isArray(f.priorityIn) && f.priorityIn.length)
      p.set('priority', f.priorityIn.join(','));
    if (f.slaBreached) p.set('sla', 'breached');
    if (f.unreadOnly) p.set('unread', '1');
    if (f.readNoReply) p.set('seen', '1');
    if (f.sort && f.sort !== 'newest') p.set('sort', String(f.sort));
    const qs = p.toString();
    return qs ? `/inbox?${qs}` : '/inbox';
  };

  const inboxList = inboxRows.map((i) => ({
    id: i.id,
    name: i.name,
    color: i.color,
    connected: i.connections.some((c) => c.status === 'connected'),
  }));

  return (
    <RealtimeProvider
      currentUser={{ id: user.id, name: user.name ?? null, image: user.image ?? null }}
    >
      <KeymapProvider preference={user.preferences?.keymap as KeymapPreference | undefined}>
      <div className="flex h-dvh flex-col overflow-hidden">
        {user.impersonatedBy && (
          <ImpersonationBanner
            viewingAs={user.name ?? user.email}
            actorName={user.impersonatedBy.name ?? user.impersonatedBy.email}
          />
        )}
        <ChannelHealthBanner initial={unhealthy} />
        <MobileTopBar />
        <div className="flex min-h-0 flex-1">
          <SidebarShell>
            <Sidebar
              user={{ name: user.name, email: user.email, image: user.image }}
              counts={{ ...counts, pending }}
              inboxes={inboxList}
              showAdminPanel={can(user, 'system.admin')}
              // ALL folders, sections included: a section groups the inbox
              // list AND has a sidebar row — the row is how you jump straight
              // to "just the verification codes" with a live count.
              views={viewRows.map((v) => ({
                id: v.id,
                name: v.name,
                href: viewHref(v.filters as Record<string, unknown>),
                count: v.count,
              }))}
            />
          </SidebarShell>
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </div>
      <CommandPalette
        tags={tagRows.map((t) => ({ id: t.id, name: t.name }))}
        isAdmin={can(user, 'automations.manage')}
      />
      <NewConversation
        inboxes={inboxRows
          .filter((i) => i.connections.length > 0)
          .map((i) => ({ id: i.id, name: i.name, color: i.color, isDefault: i.isDefault }))}
      />
      {/* One listener for the whole app: `c`, ⌘K and the jump keys should work
          from settings too, not only inside the inbox. */}
      <KeyboardShortcuts />
      </KeymapProvider>
    </RealtimeProvider>
  );
}
