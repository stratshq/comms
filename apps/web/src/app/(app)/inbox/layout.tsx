import { requireUser } from '@/lib/session';
import {
  listConversations,
  listInboxes,
  listTags,
  listAgents,
  listSavedViews,
} from '@/server/queries';
import { myDraftConversationIds } from '@/server/actions/drafts';
import { ConversationListPane, type SectionFilters } from '@/components/inbox/conversation-list';
import { TagQuickPicker } from '@/components/inbox/tag-quick-picker';
import { NewFolderDialog } from '@/components/inbox/new-folder';

export const dynamic = 'force-dynamic';

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [conversations, inboxRows, tagRows, agentRows, viewRows, draftIds] =
    await Promise.all([
      // Load the working set once; the pane filters and sorts it client-side so
      // every filter change is instant.
      listConversations({ status: 'all' }),
      listInboxes(),
      listTags(),
      listAgents(),
      listSavedViews(user.id),
      myDraftConversationIds(user.id),
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
        // Folders set to render inside the list rather than in the sidebar.
        folders={viewRows
          .filter((v) => v.display === 'section')
          .map((v) => ({
            id: v.id,
            name: v.name,
            filters: (v.filters ?? {}) as SectionFilters,
          }))}
        draftConversationIds={draftIds}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <TagQuickPicker
        allTags={tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      />
      <NewFolderDialog
        tags={tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        inboxes={inboxRows.map((i) => ({ id: i.id, name: i.name }))}
      />
    </div>
  );
}
