import { resolvePreferences } from '@comms/db';
import { requireDbUser } from '@/lib/session';
import {
  listConversations,
  listInboxes,
  listTags,
  listAgents,
  listSavedViews,
  myPinnedConversationIds,
} from '@/server/queries';
import { myDraftConversationIds } from '@/server/actions/drafts';
import { ConversationListPane, type SectionFilters } from '@/components/inbox/conversation-list';
import { TagQuickPicker } from '@/components/inbox/tag-quick-picker';
import { NewFolderDialog } from '@/components/inbox/new-folder';

export const dynamic = 'force-dynamic';

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const user = await requireDbUser();
  const prefs = resolvePreferences(user.preferences);
  const [conversations, inboxRows, tagRows, agentRows, viewRows, draftIds, pinnedIds] =
    await Promise.all([
      // Load the working set once; the pane filters and sorts it client-side so
      // every filter change is instant.
      listConversations({ status: 'all' }),
      listInboxes(),
      listTags(),
      listAgents(),
      listSavedViews(user.id),
      myDraftConversationIds(user.id),
      myPinnedConversationIds(user.id),
    ]);

  return (
    <div className="flex h-full min-h-0 flex-1">
      <ConversationListPane
        conversations={conversations}
        currentUserId={user.id}
        currentUserName={user.name ?? 'You'}
        showChannels={inboxRows.length > 1}
        allTags={tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        agents={agentRows.map((a) => ({ id: a.id, name: a.name, email: a.email }))}
        inboxes={inboxRows.map((i) => ({ id: i.id, name: i.name }))}
        // Every folder, not just the sections: the pane needs the sidebar
        // ones too, to resolve `?view=` for rules a URL cannot spell.
        folders={viewRows.map((v) => ({
          id: v.id,
          name: v.name,
          display: v.display,
          filters: (v.filters ?? {}) as SectionFilters,
        }))}
        draftConversationIds={draftIds}
        pinnedConversationIds={pinnedIds}
        pinnedFirst={prefs.pinnedFirst}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <TagQuickPicker
        allTags={tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      />
      <NewFolderDialog
        tags={tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        inboxes={inboxRows.map((i) => ({ id: i.id, name: i.name }))}
        agents={agentRows.map((a) => ({ id: a.id, name: a.name, email: a.email }))}
      />
    </div>
  );
}
