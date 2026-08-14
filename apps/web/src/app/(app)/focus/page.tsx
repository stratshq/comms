import { isAiConfigured } from '@comms/ai';
import {
  getConversation,
  getMessages,
  listConversations,
  listInboxes,
  listMacros,
  getConnectionForInbox,
} from '@/server/queries';
import { getSetting } from '@/server/settings';
import { resolveSignature } from '@/server/signature';
import { getMyDraft, listSharedDrafts } from '@/server/actions/drafts';
import { can, requireDbUser } from '@/lib/session';
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from '@/lib/availability';
import { conversationName } from '@/lib/naming';
import { FocusShell } from '@/components/focus/focus-shell';

export const dynamic = 'force-dynamic';

/**
 * Focus & Reply: one conversation, full screen, a counter, and nothing else.
 *
 * The queue is a snapshot of a real folder (inbox / mine / drafts) taken when
 * you enter; each send or close advances to the next thread. The HEY idea,
 * with Superhuman's cadence: you don't triage a list, you work a stack.
 */

const QUEUES: Record<string, { label: string; filter: Parameters<typeof listConversations>[0] }> = {
  inbox: { label: 'Inbox', filter: { status: 'active' } },
  mine: { label: 'Assigned to me', filter: { status: 'active', assignee: 'me' } },
  unassigned: { label: 'Unassigned', filter: { status: 'active', assignee: 'unassigned' } },
  drafts: { label: 'Drafts', filter: { status: 'drafts' } },
};

export default async function FocusPage({
  searchParams,
}: {
  searchParams: Promise<{ queue?: string; c?: string }>;
}) {
  const { queue: queueParam, c } = await searchParams;
  const user = await requireDbUser();
  const queueKey = queueParam && QUEUES[queueParam] ? queueParam : 'inbox';
  const queue = QUEUES[queueKey]!;

  const rows = await listConversations({ ...queue.filter, currentUserId: user.id });
  const ids = rows.map((r) => r.id);
  const currentId = c && ids.includes(c) ? c : ids[0];

  if (!currentId) {
    return <FocusShell queueKey={queueKey} queueLabel={queue.label} ids={[]} thread={null} />;
  }

  const [conversation, messages, macros, inboxes, connection, draft, sharedDrafts, hoursSetting] =
    await Promise.all([
      getConversation(currentId),
      getMessages(currentId),
      listMacros(),
      listInboxes(),
      getConnectionForInbox(rows.find((r) => r.id === currentId)!.inboxId),
      getMyDraft(currentId),
      listSharedDrafts(currentId),
      getSetting<Partial<BusinessHours>>('business_hours'),
    ]);
  if (!conversation) {
    return <FocusShell queueKey={queueKey} queueLabel={queue.label} ids={[]} thread={null} />;
  }

  const signature = await resolveSignature(user.id, conversation.inboxId);
  const ai = (conversation.metadata as { ai?: { draft?: string } } | null)?.ai;

  return (
    <FocusShell
      queueKey={queueKey}
      queueLabel={queue.label}
      ids={ids}
      thread={{
        conversationId: conversation.id,
        number: conversation.number,
        name: conversationName({
          contactName: conversation.contact?.displayName,
          contactAddress: conversation.contact?.identities?.[0]?.value,
          chatGuid: conversation.providerChatGuid,
          title: conversation.title,
          isGroup: conversation.isGroup,
        }),
        status: conversation.status,
        macros: macros.map((m) => ({
          id: m.id,
          name: m.name,
          body: m.body,
          shortcut: m.shortcut,
          hasActions: Object.keys(m.actions ?? {}).length > 0,
        })),
        aiEnabled: await isAiConfigured(),
        aiDraft: ai?.draft ?? null,
        initialDraft: draft,
        canReact: Boolean(connection?.capabilities?.privateApi),
        isAdmin: can(user, 'workspace.manage'),
        sharedDrafts: sharedDrafts.map((d) => ({
          authorUserId: d.authorUserId,
          authorName: d.authorName,
          body: d.body,
          sharedAt: d.sharedAt.toISOString(),
          mine: d.mine,
        })),
        businessHours: { ...DEFAULT_BUSINESS_HOURS, ...(hoursSetting ?? {}) },
        signaturePreview: signature,
        viaInbox:
          inboxes.length > 1 && conversation.inbox
            ? { name: conversation.inbox.name, color: conversation.inbox.color }
            : null,
        messages: messages.map((m) => ({
          id: m.id,
          body: m.body,
          providerMessageGuid: m.providerMessageGuid,
          authorType: m.authorType,
          direction: m.direction,
          isPrivateNote: m.isPrivateNote,
          status: m.status,
          error: m.error,
          authorName: m.authorUser?.name ?? null,
          draftedByName:
            ((m.metadata as { draftedBy?: { name?: string | null } } | null)?.draftedBy?.name ??
              null) || null,
          reactionType: m.reactionType,
          createdAt: m.createdAt,
          sentAt: m.sentAt,
          readAt: m.readAt,
          deliveredAt: m.deliveredAt,
          attachments: m.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            mimeType: a.mimeType,
            status: a.status,
            isVoiceMemo: a.isVoiceMemo,
            playable: Boolean(a.playableStorageKey),
            transcript: a.transcript,
            transcriptSource: a.transcriptSource,
          })),
        })),
      }}
    />
  );
}
