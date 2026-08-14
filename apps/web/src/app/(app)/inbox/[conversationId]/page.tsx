import { notFound } from 'next/navigation';
import { isAiConfigured } from '@comms/ai';
import {
  getConversation,
  getMessages,
  listAgents,
  listTags,
  listMacros,
  listInboxes,
  getConnectionForInbox,
  getPersonContext,
  getThreadMedia,
  getIntroContext,
  getGroupParticipants,
  myPinnedConversationIds,
} from '@/server/queries';
import { getSetting } from '@/server/settings';
import { resolveSignature } from '@/server/signature';
import { ThreadShell } from '@/components/inbox/thread-shell';
import { getMyDraft, listSharedDrafts } from '@/server/actions/drafts';
import { TicketPanel } from '@/components/inbox/ticket-panel';
import { ConversationHeader } from '@/components/inbox/conversation-header';
import { DetailsPane } from '@/components/inbox/details-pane';
import { InstantIntro } from '@/components/inbox/instant-intro';
import { NudgeBanner, type NudgeData } from '@/components/inbox/nudge-banner';
import { DetailsPaneShell } from '@/components/app/mobile-shell';
import { can, requireDbUser } from '@/lib/session';
import { extractSelfIntroduction } from '@/lib/intro';
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from '@/lib/availability';
import { addressFromChatGuid, conversationName, formatAddress } from '@/lib/naming';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const [conversation, user] = await Promise.all([
    getConversation(conversationId),
    requireDbUser(),
  ]);
  if (!conversation) notFound();

  const [
    messages,
    agents,
    tags,
    macros,
    inboxes,
    connection,
    draft,
    person,
    media,
    intro,
    sharedDrafts,
    hoursSetting,
    signature,
    participants,
    pinnedIds,
  ] = await Promise.all([
    getMessages(conversationId),
    listAgents(),
    listTags(),
    listMacros(),
    listInboxes(),
    getConnectionForInbox(conversation.inboxId),
    getMyDraft(conversationId),
    getPersonContext(conversationId, conversation.contactId),
    getThreadMedia(conversationId),
    getIntroContext(conversationId, conversation.contactId),
    listSharedDrafts(conversationId),
    getSetting<Partial<BusinessHours>>('business_hours'),
    resolveSignature(user.id, conversation.inboxId),
    conversation.isGroup ? getGroupParticipants(conversationId) : Promise.resolve([]),
    myPinnedConversationIds(user.id),
  ]);

  // Tapbacks, typing indicators and edits all require the BlueBubbles Private
  // API; hide the affordances entirely when the Mac can't deliver them.
  const canReact = Boolean(connection?.capabilities?.privateApi);

  const contactName = conversationName({
    contactName: conversation.contact?.displayName,
    contactAddress: conversation.contact?.identities?.[0]?.value,
    chatGuid: conversation.providerChatGuid,
    title: conversation.title,
    isGroup: conversation.isGroup,
  });
  const contactIdentities =
    conversation.contact?.identities
      ?.map((i) => formatAddress(i.rawValue ?? i.value) ?? i.value)
      .filter((v): v is string => Boolean(v)) ?? [];
  const aiEnabled = await isAiConfigured();
  const meta = conversation.metadata as {
    ai?: { summary?: string; topic?: string; sentiment?: string; draft?: string };
    nudge?: { excerpt?: string; dueAt?: string; dismissedAt?: string };
  } | null;
  const ai = meta?.ai;
  const nudge: NudgeData | null =
    meta?.nudge?.excerpt && meta.nudge.dueAt && !meta.nudge.dismissedAt
      ? { excerpt: meta.nudge.excerpt, dueAt: meta.nudge.dueAt }
      : null;

  // Instant Intro: only while the contact is unnamed — the moment they have a
  // name, the person card answers "who is this" better than inference can.
  const isUnknown = !conversation.isGroup && !conversation.contact?.displayName?.trim();
  const introduction = isUnknown ? extractSelfIntroduction(intro.firstInboundBody) : null;
  const rawAddress =
    conversation.contact?.identities?.[0]?.rawValue ??
    conversation.contact?.identities?.[0]?.value ??
    addressFromChatGuid(conversation.providerChatGuid);

  const businessHours: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, ...(hoursSetting ?? {}) };
  const multipleInboxes = inboxes.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationHeader
          conversationId={conversation.id}
          number={conversation.number}
          name={contactName}
          status={conversation.status}
          muted={Boolean(conversation.mutedAt)}
          pinned={pinnedIds.includes(conversation.id)}
        />
        {nudge && <NudgeBanner conversationId={conversation.id} nudge={nudge} />}
        <ThreadShell
          conversationId={conversation.id}
          macros={macros.map((m) => ({
            id: m.id,
            name: m.name,
            body: m.body,
            shortcut: m.shortcut,
            hasActions: Object.keys(m.actions ?? {}).length > 0,
          }))}
          aiEnabled={aiEnabled}
          aiDraft={ai?.draft ?? null}
          initialDraft={draft}
          canReact={canReact}
          sharedDrafts={sharedDrafts.map((d) => ({
            authorUserId: d.authorUserId,
            authorName: d.authorName,
            body: d.body,
            sharedAt: d.sharedAt.toISOString(),
            mine: d.mine,
          }))}
          isAdmin={can(user, 'workspace.manage')}
          businessHours={businessHours}
          signaturePreview={signature}
          viaInbox={
            multipleInboxes && conversation.inbox
              ? { name: conversation.inbox.name, color: conversation.inbox.color }
              : null
          }
          messages={messages.map((m) => ({
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
          }))}
        />
      </div>
      <DetailsPaneShell>
        <DetailsPane
          gallery={{
            photos: media.photos.map((p) => ({ ...p, at: p.at.toISOString() })),
            files: media.files.map((f) => ({ ...f, at: f.at.toISOString() })),
            links: media.links.map((l) => ({ ...l, at: l.at.toISOString() })),
          }}
          schedule={{
            scheduledSends: messages
              .filter((m) => m.status === 'queued' && m.scheduledFor)
              .map((m) => ({ id: m.id, body: m.body, dueAt: m.scheduledFor!.toISOString() })),
            followUpAt: conversation.followUpAt?.toISOString() ?? null,
            snoozedUntil:
              conversation.status === 'snoozed'
                ? (conversation.snoozedUntil?.toISOString() ?? null)
                : null,
          }}
          details={
            <>
              {isUnknown && (
                <InstantIntro
                  contactId={conversation.contactId}
                  address={formatAddress(rawAddress)}
                  rawAddress={rawAddress}
                  conversationCount={intro.conversationCount}
                  introducedName={introduction?.name ?? null}
                  introducedCompany={introduction?.company ?? null}
                  optedOut={Boolean(conversation.contact?.optedOutAt)}
                />
              )}
              <TicketPanel
                conversation={{
                  id: conversation.id,
                  status: conversation.status,
                  priority: conversation.priority,
                  assigneeId: conversation.assigneeId,
                  contactName,
                  contactIdentities: contactIdentities.length
                    ? contactIdentities
                    : // Fall back to the address in the chat GUID rather than claiming
                      // we have no contact info for a thread we can clearly reply to.
                      [formatAddress(addressFromChatGuid(conversation.providerChatGuid))].filter(
                        (v): v is string => Boolean(v),
                      ),
                  inboxId: conversation.inboxId,
                  inboxName: conversation.inbox?.name ?? 'Inbox',
                  tagIds: conversation.tags?.map((t) => t.tag.id) ?? [],
                  isGroup: conversation.isGroup,
                }}
                participants={participants}
                contact={
                  conversation.contact
                    ? {
                        id: conversation.contact.id,
                        notes: conversation.contact.notes,
                        company: conversation.contact.company,
                        attributes: conversation.contact.attributes ?? {},
                      }
                    : null
                }
                canManageTags={can(user, 'workspace.manage')}
                canRenameInbox={can(user, 'inboxes.manage')}
                person={{
                  name: contactName,
                  avatarUrl: conversation.contact?.avatarUrl ?? null,
                  addresses: person.addresses,
                  lastMessageAt: person.lastMessageAt?.toISOString() ?? null,
                  lastInboundAt: person.lastInboundAt?.toISOString() ?? null,
                  firstMessageAt: person.firstMessageAt?.toISOString() ?? null,
                  totalMessages: person.totalMessages,
                  recentMessages: person.recentMessages,
                  photos: person.photos,
                  photoCount: person.photoCount,
                  isGroup: conversation.isGroup,
                  contactId: conversation.contactId,
                }}
                agents={agents.map((a) => ({ id: a.id, name: a.name, email: a.email }))}
                allTags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
                ai={ai ? { summary: ai.summary, topic: ai.topic, sentiment: ai.sentiment } : null}
                sla={{
                  nextResponseDueAt: conversation.nextResponseDueAt,
                  slaBreachedAt: conversation.slaBreachedAt,
                  csatScore: conversation.csatScore,
                }}
              />
            </>
          }
        />
      </DetailsPaneShell>
    </div>
  );
}
