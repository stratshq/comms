import 'server-only';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from '@comms/db';
import {
  attachments,
  contactIdentities,
  contacts,
  conversations,
  conversationParticipants,
  conversationPins,
  drafts,
  conversationTags,
  messages,
  inboxes,
  channelConnections,
  users,
  tags,
  macros,
  automationRules,
  savedViews,
  sanitizeQuery,
  type QueryCondition,
  type FolderQuery,
} from '@comms/db';
import { db } from '@/server/db';
import { INBOX_STATUSES } from '@/lib/conversation-folder';

export type ConversationFilter = {
  /**
   * 'active' is the inbox: open and pending only.
   *
   * Snoozed and closed conversations are deliberately NOT in it. Snoozing
   * something that stays in the list is just a label — the whole point is that
   * it leaves and comes back, the way it does in every mail client. Each has
   * its own view instead.
   */
  status?: 'open' | 'pending' | 'snoozed' | 'closed' | 'drafts' | 'active' | 'all';
  assignee?: 'me' | 'unassigned' | string;
  /** Correspondent class — the split-inbox axis. */
  kind?: 'person' | 'unknown' | 'automated' | 'otp';
  /** Any of these words appearing in a message body (OR within the list). */
  bodyContains?: string[];
  inboxId?: string;
  tagIds?: string[];
  priorityIn?: Array<'low' | 'normal' | 'high' | 'urgent'>;
  slaBreached?: boolean;
  unreadOnly?: boolean;
  /**
   * They opened your last message and never wrote back.
   *
   * A completely different state from "they never saw it", and the most
   * actionable signal iMessage gives us — email clients approximate this with
   * tracking pixels; Apple hands us the real timestamp.
   */
  readNoReply?: boolean;
  /** Conversations containing a photo, any attachment, a voice memo, or a link. */
  has?: 'photo' | 'attachment' | 'voice' | 'link';
  /** Only conversations the viewer has pinned. */
  pinnedOnly?: boolean;
  /** A custom AND/OR condition set, ANDed with the flat fields above. */
  query?: FolderQuery;
  sort?: 'newest' | 'oldest' | 'priority';
  /** Float the viewer's pinned conversations to the top of the list. */
  pinnedFirst?: boolean;
  search?: string;
  currentUserId?: string;
};

/**
 * True when some outbound message has been read and nothing inbound arrived
 * after it — i.e. the ball is in their court and they know it.
 *
 * Computed rather than denormalized: a `lastOutboundReadAt` column would have
 * to be maintained at four write sites (send, ingest echo, updated-message
 * receipt, chat-read-status webhook) and would be wrong the moment one of them
 * was missed.
 */
const READ_NO_REPLY = sql<boolean>`exists (
  select 1 from ${messages} m
  where m.conversation_id = ${conversations.id}
    and m.direction = 'outbound'
    and m.is_private_note = false
    -- System events ("Assigned to X", "Follow-up reminder") are stored as
    -- outbound with status 'sent', and the chat-read-status webhook marks
    -- every such row read in bulk. Without this they would trip the filter on
    -- conversations nobody actually wrote to.
    and m.author_type <> 'system'
    -- A tapback we sent is not "a message they read and ignored"; counting it
    -- flagged conversations where WE owed the reply.
    and m.reaction_type is null
    and m.read_at is not null
    and not exists (
      select 1 from ${messages} m2
      where m2.conversation_id = ${conversations.id}
        and m2.direction = 'inbound'
        and m2.author_type <> 'system'
        and m2.created_at > m.created_at
    )
)`;

/**
 * "Photos from Jordan" — a query people genuinely make and which nothing in
 * the product could answer.
 *
 * Links are matched on the message body rather than on an attachment row,
 * because a URL in a text is not an attachment; everything else joins to
 * `attachments`, using `isVoiceMemo` rather than the mime type since
 * BlueBubbles rewrites mime types during its audio conversion pass.
 */
function hasMediaCondition(kind: 'photo' | 'attachment' | 'voice' | 'link') {
  if (kind === 'link') {
    return sql`exists (
      select 1 from ${messages} m
      where m.conversation_id = ${conversations.id}
        and m.body ~* '(https?://|www\.)'
    )`;
  }

  const attachmentWhere =
    kind === 'photo'
      ? sql`and a.mime_type like 'image/%'`
      : kind === 'voice'
        ? sql`and a.is_voice_memo = true`
        : sql``;

  return sql`exists (
    select 1 from ${attachments} a
    join ${messages} m on m.id = a.message_id
    where m.conversation_id = ${conversations.id} ${attachmentWhere}
  )`;
}

/** Escape LIKE metacharacters so a stored word matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One folder condition as SQL.
 *
 * The client-side twin lives in `@/lib/folder-query` and must stay in step —
 * a folder whose badge counts differently from its contents is exactly the
 * bug this pair exists to avoid, so both are driven by the same shared
 * condition shape and covered by the same tests.
 */
function conditionSql(c: QueryCondition, currentUserId?: string) {
  const negate = (positive: ReturnType<typeof sql>) => sql`not (${positive})`;
  const yes = c.value !== 'false';

  switch (c.field) {
    case 'kind': {
      const base = sql`${conversations.kind} = ${c.value}`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'priority': {
      const base = sql`${conversations.priority} = ${c.value}`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'status': {
      const base = sql`${conversations.status} = ${c.value}`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'inbox': {
      const base = sql`${conversations.inboxId} = ${c.value}`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'assignee': {
      const base =
        c.value === 'unassigned'
          ? sql`${conversations.assigneeId} is null`
          : sql`${conversations.assigneeId} = ${c.value === 'me' ? (currentUserId ?? '') : c.value}`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'tag': {
      const base = sql`exists (
        select 1 from ${conversationTags} ct
        where ct.conversation_id = ${conversations.id} and ct.tag_id = ${c.value}
      )`;
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'words': {
      const like = `%${escapeLike(c.value)}%`;
      const base = sql`(${conversations.lastMessagePreview} ilike ${like} escape '\\' or ${conversations.title} ilike ${like} escape '\\')`;
      return c.operator === 'not_contains' ? negate(base) : base;
    }
    case 'has': {
      const base = hasMediaCondition(c.value as 'photo' | 'attachment' | 'voice' | 'link');
      return c.operator === 'is_not' ? negate(base) : base;
    }
    case 'unread': {
      const base = sql`${conversations.unreadCount} > 0`;
      return yes ? base : negate(base);
    }
    case 'seen': {
      return yes ? READ_NO_REPLY : negate(READ_NO_REPLY);
    }
    case 'muted': {
      const base = sql`${conversations.mutedAt} is not null`;
      return yes ? base : negate(base);
    }
    case 'sla': {
      const base = sql`${conversations.slaBreachedAt} is not null`;
      return yes ? base : negate(base);
    }
    case 'pinned': {
      const base = currentUserId
        ? sql`exists (
            select 1 from ${conversationPins} p
            where p.conversation_id = ${conversations.id} and p.user_id = ${currentUserId}
          )`
        : sql`false`;
      return yes ? base : negate(base);
    }
    default:
      // An unknown field must not read as "no restriction".
      return sql`false`;
  }
}

/** SQL conditions shared by the list query and the per-view counts. */
function buildConversationWhere(filter: ConversationFilter) {
  const where = [];

  if (filter.status === 'active') {
    where.push(inArray(conversations.status, INBOX_STATUSES));
  } else if (filter.status === 'drafts') {
    // Drafts is the one folder that isn't a status, and it's per-person: with
    // no user in context it must match nothing rather than everything.
    where.push(
      filter.currentUserId
        ? sql`exists (
            select 1 from ${drafts} d
            where d.conversation_id = ${conversations.id}
              and d.user_id = ${filter.currentUserId}
              and length(btrim(d.body)) > 0
          )`
        : sql`false`,
    );
  } else if (filter.status && filter.status !== 'all') {
    where.push(eq(conversations.status, filter.status));
  }

  if (filter.inboxId) where.push(eq(conversations.inboxId, filter.inboxId));

  if (filter.assignee === 'unassigned') where.push(isNull(conversations.assigneeId));
  else if (filter.assignee === 'me' && filter.currentUserId) {
    where.push(eq(conversations.assigneeId, filter.currentUserId));
  } else if (filter.assignee && filter.assignee !== 'me') {
    where.push(eq(conversations.assigneeId, filter.assignee));
  }

  if (filter.priorityIn?.length) {
    where.push(inArray(conversations.priority, filter.priorityIn));
  }

  if (filter.kind) where.push(eq(conversations.kind, filter.kind));

  if (filter.bodyContains?.length) {
    const words = filter.bodyContains.map((w) => w.trim()).filter(Boolean);
    if (words.length) {
      /**
       * Matched against the latest message and the title, NOT every message
       * ever sent.
       *
       * Searching the whole archive would be more powerful and would make the
       * folder lie: the list pane filters the loaded working set client-side
       * and can only see each row's preview, so a badge counted over all
       * messages would promise threads the list then couldn't show. A folder
       * whose count disagrees with its contents is worse than a folder with a
       * shallower rule — and the full-archive search already exists in the
       * search box and in Ask.
       *
       * OR within the list: "invoice OR receipt OR billing" is one folder.
       */
      const clauses = words.map((w) => {
        // A saved word is a literal, so `%` and `_` must not act as wildcards
        // — "50%" should find "50%", not everything containing "50".
        const like = `%${escapeLike(w)}%`;
        return sql`(${conversations.lastMessagePreview} ilike ${like} escape '\\' or ${conversations.title} ilike ${like} escape '\\')`;
      });
      where.push(sql`(${sql.join(clauses, sql` or `)})`);
    }
  }

  if (filter.pinnedOnly) {
    where.push(
      filter.currentUserId
        ? sql`exists (
            select 1 from ${conversationPins} p
            where p.conversation_id = ${conversations.id} and p.user_id = ${filter.currentUserId}
          )`
        : // Pins are per person; with nobody in context this matches nothing
          // rather than everything, same rule as the drafts folder.
          sql`false`,
    );
  }

  const query = sanitizeQuery(filter.query);
  if (query) {
    const clauses = query.conditions.map((c) => conditionSql(c, filter.currentUserId));
    where.push(sql`(${sql.join(clauses, query.match === 'any' ? sql` or ` : sql` and `)})`);
  }

  if (filter.readNoReply) where.push(READ_NO_REPLY);
  if (filter.has) where.push(hasMediaCondition(filter.has));
  if (filter.slaBreached) where.push(sql`${conversations.slaBreachedAt} is not null`);
  if (filter.unreadOnly) where.push(sql`${conversations.unreadCount} > 0`);

  // Tag filter: conversation must carry EVERY selected tag (AND semantics —
  // narrowing is what people expect when they add a second tag).
  if (filter.tagIds?.length) {
    for (const tagId of filter.tagIds) {
      where.push(
        sql`exists (select 1 from ${conversationTags} ct where ct.conversation_id = ${conversations.id} and ct.tag_id = ${tagId})`,
      );
    }
  }

  if (filter.search) {
    where.push(
      or(
        ilike(conversations.lastMessagePreview, `%${filter.search}%`),
        ilike(conversations.title, `%${filter.search}%`),
      )!,
    );
  }

  return where;
}

/**
 * True when the viewer has pinned this conversation.
 *
 * Pins are per person, so this is a correlated subquery rather than a column
 * — two people looking at the same shared inbox see different things at the
 * top, which is the entire point of a pin.
 */
function pinnedFor(userId: string | undefined) {
  return userId
    ? sql<boolean>`exists (
        select 1 from ${conversationPins} p
        where p.conversation_id = ${conversations.id} and p.user_id = ${userId}
      )`
    : sql<boolean>`false`;
}

function orderFor(sort: ConversationFilter['sort'], status?: ConversationFilter['status']) {
  // The question you have in the snoozed view is "what comes back next", not
  // "what was said most recently".
  if (status === 'snoozed') return [asc(conversations.snoozedUntil), desc(conversations.lastMessageAt)];

  if (sort === 'oldest') {
    return [asc(conversations.lastMessageAt), asc(conversations.createdAt)];
  }
  if (sort === 'priority') {
    // urgent → high → normal → low, then most recent within each band.
    return [
      sql`case ${conversations.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
      desc(conversations.lastMessageAt),
    ];
  }
  return [desc(conversations.lastMessageAt), desc(conversations.createdAt)];
}

export async function listConversations(filter: ConversationFilter = {}) {
  const where = buildConversationWhere(filter);
  const pinned = pinnedFor(filter.currentUserId);
  const order = orderFor(filter.sort, filter.status);

  return db.query.conversations.findMany({
    where: where.length ? and(...where) : undefined,
    // Pinned rows sort ahead of everything else but keep their normal order
    // among themselves — a pin promotes a thread, it doesn't freeze it.
    orderBy: filter.pinnedFirst && filter.currentUserId ? [desc(pinned), ...order] : order,
    limit: 100,
    // Carried on every row so the client-side filter can apply the same rule
    // the server does without a second round trip.
    extras: {
      readNoReply: READ_NO_REPLY.as('read_no_reply'),
      hasPhoto: hasMediaCondition('photo').as('has_photo'),
      hasAttachment: hasMediaCondition('attachment').as('has_attachment'),
      hasVoice: hasMediaCondition('voice').as('has_voice'),
      hasLink: hasMediaCondition('link').as('has_link'),
    },
    with: {
      // Identities come along so an unnamed thread can show the phone number
      // instead of a blank row.
      contact: {
        columns: { id: true, displayName: true, avatarUrl: true },
        with: { identities: { columns: { value: true, rawValue: true } } },
      },
      assignee: { columns: { id: true, name: true, image: true } },
      inbox: { columns: { id: true, name: true, color: true } },
      tags: { with: { tag: true } },
      bundle: { columns: { id: true, name: true } },
    },
  });
}

/** Live count for one saved view — powers the sidebar badges. */
export async function countConversations(filter: ConversationFilter): Promise<number> {
  const where = buildConversationWhere(filter);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(conversations)
    .where(where.length ? and(...where) : undefined);
  return Number(row?.n ?? 0);
}

/** Saved views (folders) visible to a user: their own plus every shared one. */
export async function listSavedViews(userId: string) {
  const rows = await db.query.savedViews.findMany({
    where: or(eq(savedViews.ownerUserId, userId), eq(savedViews.isShared, true)),
    orderBy: [asc(savedViews.sortOrder), asc(savedViews.createdAt)],
  });

  return Promise.all(
    rows.map(async (v) => ({
      ...v,
      count: await countConversations({ ...v.filters, currentUserId: userId }),
    })),
  );
}

export type ConversationListItem = Awaited<ReturnType<typeof listConversations>>[number];

export async function getConversation(id: string) {
  return db.query.conversations.findFirst({
    where: eq(conversations.id, id),
    with: {
      contact: { with: { identities: true } },
      assignee: { columns: { id: true, name: true, image: true } },
      inbox: { columns: { id: true, name: true, color: true } },
      tags: { with: { tag: true } },
    },
  });
}

export async function getMessages(conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: [asc(messages.createdAt)],
    with: {
      attachments: true,
      authorUser: { columns: { id: true, name: true, image: true } },
    },
  });
}

export async function getConnectionForInbox(inboxId: string) {
  return db.query.channelConnections.findFirst({
    where: eq(channelConnections.inboxId, inboxId),
  });
}

export async function listInboxes() {
  return db.query.inboxes.findMany({
    orderBy: [desc(inboxes.isDefault), asc(inboxes.name)],
    with: { connections: true },
  });
}

export async function listAgents() {
  return db.query.users.findMany({
    where: eq(users.status, 'active'),
    columns: { id: true, name: true, email: true, image: true, roleId: true },
    with: { role: { columns: { id: true, name: true } } },
    orderBy: [asc(users.name)],
  });
}

export async function listTags() {
  return db.query.tags.findMany({ orderBy: [asc(tags.name)] });
}

/**
 * The ids one person has pinned.
 *
 * Sent to the list pane as a set rather than joined onto each row: the pane
 * already holds the whole working set client-side, so a pin toggle only has
 * to move an id in and out of a set instead of refetching every conversation.
 */
export async function myPinnedConversationIds(userId: string): Promise<string[]> {
  const rows = await db.query.conversationPins.findMany({
    where: eq(conversationPins.userId, userId),
    columns: { conversationId: true },
    orderBy: [desc(conversationPins.createdAt)],
  });
  return rows.map((r) => r.conversationId);
}

export async function listMacros() {
  return db.query.macros.findMany({ orderBy: [asc(macros.name)] });
}

export async function listAutomationRules() {
  return db.query.automationRules.findMany({ orderBy: [asc(automationRules.sortOrder)] });
}

/** Sidebar counts as one SQL aggregate — replaces loading 1000 rows into Node. */
export async function inboxCounts(currentUserId: string) {
  const [row] = await db
    .select({
      // Every count uses the same definition of "in the inbox" as the list,
      // or a badge promises work that isn't there when you click it.
      open: sql<number>`count(*) filter (where ${conversations.status} in ('open','pending'))`,
      mine: sql<number>`count(*) filter (where ${conversations.assigneeId} = ${currentUserId} and ${conversations.status} in ('open','pending'))`,
      unassigned: sql<number>`count(*) filter (where ${conversations.assigneeId} is null and ${conversations.status} in ('open','pending'))`,
      snoozed: sql<number>`count(*) filter (where ${conversations.status} = 'snoozed')`,
      closed: sql<number>`count(*) filter (where ${conversations.status} = 'closed')`,
      // Drafts are per-person, so this one is not a property of the workspace
      // the way the others are.
      drafts: sql<number>`(
        select count(*) from ${drafts} d
        where d.user_id = ${currentUserId} and length(btrim(d.body)) > 0
      )`,
    })
    .from(conversations);
  return {
    open: Number(row?.open ?? 0),
    mine: Number(row?.mine ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    snoozed: Number(row?.snoozed ?? 0),
    drafts: Number(row?.drafts ?? 0),
    closed: Number(row?.closed ?? 0),
  };
}

/**
 * Connections that are down (status != connected) or silently stale (still
 * marked connected but no heartbeat for 3+ minutes — the worker is dead or the
 * Mac is asleep). Feeds the channel-health banner's initial state.
 */
export async function listUnhealthyConnections() {
  const staleBefore = new Date(Date.now() - 3 * 60_000);
  const rows = await db
    .select({
      connectionId: channelConnections.id,
      status: channelConnections.status,
      lastHeartbeatAt: channelConnections.lastHeartbeatAt,
      inboxName: inboxes.name,
    })
    .from(channelConnections)
    .innerJoin(inboxes, eq(channelConnections.inboxId, inboxes.id));

  return rows
    .filter(
      (r) =>
        r.status === 'error' ||
        r.status === 'disconnected' ||
        (r.status === 'connected' && (!r.lastHeartbeatAt || r.lastHeartbeatAt < staleBefore)),
    )
    .map((r) => ({
      connectionId: r.connectionId,
      inboxName: r.inboxName,
      reason: (r.status === 'connected' ? 'stale' : 'error') as 'error' | 'stale',
    }));
}

export interface PersonContext {
  /** Every address we know for them, formatted for display. */
  addresses: { value: string; raw: string | null }[];
  /** Most recent message either way. */
  lastMessageAt: Date | null;
  /** Most recent message FROM them — "when did I last hear from you". */
  lastInboundAt: Date | null;
  /** First message either way, so the relationship has a start date. */
  firstMessageAt: Date | null;
  totalMessages: number;
  /** Messages in the last 90 days, which is what "how often" actually means. */
  recentMessages: number;
  /** Image attachments in this conversation, newest first. */
  photos: { id: string; fileName: string | null }[];
  photoCount: number;
}

/**
 * Everything the details panel needs to answer "who am I talking to".
 *
 * One query per fact rather than one giant join: they have different shapes
 * (aggregate, list, limit) and a join would multiply rows against the
 * attachments table.
 */
export async function getPersonContext(
  conversationId: string,
  contactId: string | null,
): Promise<PersonContext> {
  const [identityRows, stats, photoRows, photoTotal] = await Promise.all([
    contactId
      ? db
          .select({ value: contactIdentities.value, raw: contactIdentities.rawValue })
          .from(contactIdentities)
          .where(eq(contactIdentities.contactId, contactId))
          // Phones first and deterministic: the panel treats row 0 as the
          // primary address and infers their timezone from it, so an email
          // sorting first would silently drop the local time.
          .orderBy(
            sql`case ${contactIdentities.kind} when 'phone' then 0 when 'handle' then 1 else 2 end`,
            asc(contactIdentities.value),
          )
      : Promise.resolve([]),

    db
      .select({
        total: sql<number>`count(*)`,
        recent: sql<number>`count(*) filter (where ${messages.createdAt} > now() - interval '90 days')`,
        lastAt: sql<Date | null>`max(coalesce(${messages.sentAt}, ${messages.createdAt}))`,
        firstAt: sql<Date | null>`min(coalesce(${messages.sentAt}, ${messages.createdAt}))`,
        lastInbound: sql<Date | null>`max(coalesce(${messages.sentAt}, ${messages.createdAt})) filter (where ${messages.direction} = 'inbound')`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          // System events are ours, not theirs, and would inflate every count.
          sql`${messages.authorType} <> 'system'`,
        ),
      ),

    db
      .select({ id: attachments.id, fileName: attachments.fileName })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(attachments.status, 'stored'),
          sql`${attachments.mimeType} like 'image/%'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(6),

    db
      .select({ n: sql<number>`count(*)` })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(attachments.status, 'stored'),
          sql`${attachments.mimeType} like 'image/%'`,
        ),
      ),
  ]);

  const s = stats[0];
  return {
    addresses: identityRows,
    lastMessageAt: s?.lastAt ? new Date(s.lastAt) : null,
    lastInboundAt: s?.lastInbound ? new Date(s.lastInbound) : null,
    firstMessageAt: s?.firstAt ? new Date(s.firstAt) : null,
    totalMessages: Number(s?.total ?? 0),
    recentMessages: Number(s?.recent ?? 0),
    photos: photoRows,
    photoCount: Number(photoTotal[0]?.n ?? 0),
  };
}

export interface ThreadMedia {
  photos: { id: string; fileName: string | null; at: Date }[];
  files: { id: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null; at: Date }[];
  links: { url: string; at: Date; fromThem: boolean }[];
}

const LINK_RE = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Everything ever shared in a thread, in one place: photos as a grid, files
 * as a list, links pulled out of message bodies. The attachment gallery every
 * messaging app grows eventually, backed by three straightforward queries.
 */
export async function getThreadMedia(conversationId: string): Promise<ThreadMedia> {
  const [photoRows, fileRows, linkMessages] = await Promise.all([
    db
      .select({ id: attachments.id, fileName: attachments.fileName, at: messages.createdAt })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(attachments.status, 'stored'),
          sql`${attachments.mimeType} like 'image/%'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(120),

    db
      .select({
        id: attachments.id,
        fileName: attachments.fileName,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        at: messages.createdAt,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(attachments.status, 'stored'),
          sql`${attachments.mimeType} not like 'image/%'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(60),

    db
      .select({ body: messages.body, at: messages.createdAt, direction: messages.direction })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`${messages.body} ~* '(https?://)'`,
          eq(messages.isPrivateNote, false),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(80),
  ]);

  const seen = new Set<string>();
  const links: ThreadMedia['links'] = [];
  for (const m of linkMessages) {
    for (const url of m.body?.match(LINK_RE) ?? []) {
      const clean = url.replace(/[.,;:!?]+$/, '');
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push({ url: clean, at: m.at, fromThem: m.direction === 'inbound' });
    }
  }

  return { photos: photoRows, files: fileRows, links: links.slice(0, 50) };
}

export interface GroupParticipant {
  contactId: string | null;
  name: string | null;
  address: string;
  rawAddress: string | null;
  avatarUrl: string | null;
}

/**
 * Who is actually in a group conversation.
 *
 * The participants table has been populated at ingest since day one and the
 * details panel never read it — a group thread showed one phone number,
 * which answered "who is this" with a lie of omission.
 */
export interface PersonProfile {
  contact: {
    id: string;
    displayName: string | null;
    company: string | null;
    notes: string | null;
    avatarUrl: string | null;
    attributes: Record<string, string>;
    optedOutAt: Date | null;
    syncedAt: Date | null;
    createdAt: Date;
  };
  identities: { id: string; kind: string; value: string; rawValue: string | null }[];
  conversations: {
    id: string;
    title: string | null;
    isGroup: boolean;
    status: string;
    unreadCount: number;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
    providerChatGuid: string;
    inbox: { name: string; color: string } | null;
  }[];
  stats: {
    totalMessages: number;
    inbound: number;
    outbound: number;
    firstMessageAt: Date | null;
    lastInboundAt: Date | null;
  };
  photos: { id: string; fileName: string | null }[];
  photoCount: number;
}

/**
 * Everything about one person, for their own page.
 *
 * Scoped to the CONTACT rather than a single conversation — which is the
 * whole point of the page. The same human texting from two numbers, or in a
 * one-to-one and three group chats, is one person here; the details panel
 * beside a thread can only ever answer for that thread.
 */
export async function getPersonProfile(contactId: string): Promise<PersonProfile | null> {
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  if (!contact) return null;

  const identityRows = await db
    .select({
      id: contactIdentities.id,
      kind: contactIdentities.kind,
      value: contactIdentities.value,
      rawValue: contactIdentities.rawValue,
    })
    .from(contactIdentities)
    .where(eq(contactIdentities.contactId, contactId))
    .orderBy(
      sql`case ${contactIdentities.kind} when 'phone' then 0 when 'handle' then 1 else 2 end`,
      asc(contactIdentities.value),
    );

  /**
   * Their threads: the ones linked straight to the contact, plus any group
   * they appear in as a participant.
   *
   * The union matters. A group chat carries no `contactId` — it belongs to no
   * single person — so keying only on that column would show someone's
   * one-to-one thread and silently omit the four group chats they are in.
   */
  const identityIds = identityRows.map((i) => i.id);
  const memberOf = identityIds.length
    ? await db
        .selectDistinct({ id: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(inArray(conversationParticipants.contactIdentityId, identityIds))
    : [];
  const groupIds = memberOf.map((r) => r.id);

  const conversationRows = await db.query.conversations.findMany({
    where: groupIds.length
      ? or(eq(conversations.contactId, contactId), inArray(conversations.id, groupIds))
      : eq(conversations.contactId, contactId),
    orderBy: [desc(conversations.lastMessageAt)],
    limit: 100,
    with: { inbox: { columns: { name: true, color: true } } },
  });

  const conversationIds = conversationRows.map((c) => c.id);
  const scope = conversationIds.length
    ? and(
        inArray(messages.conversationId, conversationIds),
        // System events are ours, not theirs, and would inflate every count.
        sql`${messages.authorType} <> 'system'`,
      )
    : sql`false`;

  const [statRows, photoRows, photoTotal] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`,
        inbound: sql<number>`count(*) filter (where ${messages.direction} = 'inbound')`,
        outbound: sql<number>`count(*) filter (where ${messages.direction} = 'outbound')`,
        firstAt: sql<Date | null>`min(coalesce(${messages.sentAt}, ${messages.createdAt}))`,
        lastInbound: sql<Date | null>`max(coalesce(${messages.sentAt}, ${messages.createdAt})) filter (where ${messages.direction} = 'inbound')`,
      })
      .from(messages)
      .where(scope),
    conversationIds.length
      ? db
          .select({ id: attachments.id, fileName: attachments.fileName })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(
            and(
              inArray(messages.conversationId, conversationIds),
              eq(attachments.status, 'stored'),
              sql`${attachments.mimeType} like 'image/%'`,
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(12)
      : Promise.resolve([]),
    conversationIds.length
      ? db
          .select({ n: sql<number>`count(*)` })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(
            and(
              inArray(messages.conversationId, conversationIds),
              eq(attachments.status, 'stored'),
              sql`${attachments.mimeType} like 'image/%'`,
            ),
          )
      : Promise.resolve([{ n: 0 }]),
  ]);

  const s = statRows[0];
  return {
    contact: {
      id: contact.id,
      displayName: contact.displayName,
      company: contact.company,
      notes: contact.notes,
      avatarUrl: contact.avatarUrl,
      attributes: contact.attributes ?? {},
      optedOutAt: contact.optedOutAt,
      syncedAt: contact.syncedAt,
      createdAt: contact.createdAt,
    },
    identities: identityRows,
    conversations: conversationRows.map((c) => ({
      id: c.id,
      title: c.title,
      isGroup: c.isGroup,
      status: c.status,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      providerChatGuid: c.providerChatGuid,
      inbox: c.inbox ? { name: c.inbox.name, color: c.inbox.color } : null,
    })),
    stats: {
      totalMessages: Number(s?.total ?? 0),
      inbound: Number(s?.inbound ?? 0),
      outbound: Number(s?.outbound ?? 0),
      firstMessageAt: s?.firstAt ? new Date(s.firstAt) : null,
      lastInboundAt: s?.lastInbound ? new Date(s.lastInbound) : null,
    },
    photos: photoRows,
    photoCount: Number(photoTotal[0]?.n ?? 0),
  };
}

export async function getGroupParticipants(conversationId: string): Promise<GroupParticipant[]> {
  const rows = await db
    .select({
      contactId: contacts.id,
      name: contacts.displayName,
      address: contactIdentities.value,
      rawAddress: contactIdentities.rawValue,
      avatarUrl: contacts.avatarUrl,
    })
    .from(conversationParticipants)
    .innerJoin(
      contactIdentities,
      eq(contactIdentities.id, conversationParticipants.contactIdentityId),
    )
    .leftJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(eq(conversationParticipants.conversationId, conversationId));

  // Named members first, then by address — the people you know lead.
  return rows.sort((a, b) => {
    if (Boolean(a.name) !== Boolean(b.name)) return a.name ? -1 : 1;
    return (a.name ?? a.address).localeCompare(b.name ?? b.address);
  });
}

export interface IntroContext {
  /** Conversations we've had with this same person, this one included. */
  conversationCount: number;
  /** Their first message in THIS thread — where an introduction would be. */
  firstInboundBody: string | null;
  firstInboundAt: Date | null;
}

/** What we can say about who this is, before anyone decides how to answer. */
export async function getIntroContext(
  conversationId: string,
  contactId: string | null,
): Promise<IntroContext> {
  const [count, firstInbound] = await Promise.all([
    contactId
      ? db
          .select({ n: sql<number>`count(*)` })
          .from(conversations)
          .where(eq(conversations.contactId, contactId))
      : Promise.resolve([{ n: 0 }]),
    db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
      ),
      orderBy: [asc(messages.createdAt)],
      columns: { body: true, createdAt: true },
    }),
  ]);

  return {
    conversationCount: Number(count[0]?.n ?? 0),
    firstInboundBody: firstInbound?.body ?? null,
    firstInboundAt: firstInbound?.createdAt ?? null,
  };
}
