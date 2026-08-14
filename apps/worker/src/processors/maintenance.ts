import type { Job } from 'bullmq';
import {
  type MaintenanceJob,
  COMMS_WEBHOOK_EVENTS,
  COMMS_WEBHOOK_VERSION,
  addressFromChatGuid,
  classifyCorrespondent,
  describeConnectionError,
  detectCommitment,
  enqueueMaintenance,
  outboundQueue,
  loadConfig,
  publishEvent,
  logger,
} from '@comms/core';
import { repairBlankNames, syncContacts } from '../lib/contacts.js';
import { backfillParticipants, repairContactlessConversations } from '../lib/participants.js';
import { getDb, eq, and, asc, desc, lte, ne, inArray, isNotNull, sql, roleGrants } from '@comms/db';
import {
  appSettings,
  channelConnections,
  contacts,
  conversations,
  inboxes,
  messages,
  notifications,
  savedViews,
  users,
  type ViewFilters,
} from '@comms/db';
import { loadConnection } from '../lib/connection.js';
import { ingestNewMessage } from '../lib/ingest.js';
import { checkSlaBreaches } from '../lib/sla.js';

const log = logger.child({ module: 'maintenance' });

/** Marks the one-time correspondent backfill as finished. */
const KIND_BACKFILL_KEY = 'kind_backfill_done';

/** Marks the default split-inbox folders as seeded (deleting one is final). */
const FOLDERS_SEEDED_KEY = 'default_folders_seeded';

/**
 * The split inbox every install starts with.
 *
 * "Important" leads, then machine traffic under its own headers so the People
 * stream is people. Everything none of them claims falls into the list's
 * residual "Other" section, which is not a folder and cannot be deleted —
 * that Important/Other pair is the split people mean when they ask for one.
 *
 * Shared (admin-managed) and shown as sections; each can be turned off from
 * Settings → Workspace, which deletes the folder — the seeded flag makes sure
 * a deliberate off stays off across restarts.
 */
const DEFAULT_FOLDERS: { name: string; icon: string; filters: ViewFilters }[] = [
  {
    name: 'Important',
    icon: 'Star',
    // Urgent or high priority, pinned, or assigned to the person looking —
    // `assignee: 'me'` resolves per viewer, so one shared folder means
    // something different, and correct, for each of them.
    filters: {
      // What lets the Workspace switch find this folder again after someone
      // renames it or edits its rule.
      splitKey: 'important',
      query: {
        match: 'any',
        conditions: [
          { field: 'priority', operator: 'is', value: 'urgent' },
          { field: 'priority', operator: 'is', value: 'high' },
          { field: 'pinned', operator: 'is', value: 'true' },
          { field: 'assignee', operator: 'is', value: 'me' },
        ],
      },
    },
  },
  { name: 'Verification codes', icon: 'KeyRound', filters: { splitKey: 'otp', kind: 'otp' } },
  { name: 'Automated', icon: 'Bot', filters: { splitKey: 'automated', kind: 'automated' } },
  { name: 'Unknown numbers', icon: 'UserRound', filters: { splitKey: 'unknown', kind: 'unknown' } },
];

async function seedDefaultFolders() {
  const db = getDb();
  const done = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, FOLDERS_SEEDED_KEY),
  });
  if (done?.value) return;

  for (const [i, f] of DEFAULT_FOLDERS.entries()) {
    await db.insert(savedViews).values({
      name: f.name,
      icon: f.icon,
      display: 'section',
      isShared: true,
      ownerUserId: null,
      // Sections are claimed first-come, so the order here is the order the
      // inbox reads in — Important above the machine traffic, not below it.
      sortOrder: i,
      filters: { ...f.filters, status: 'active' },
    });
  }

  await db
    .insert(appSettings)
    .values({ key: FOLDERS_SEEDED_KEY, value: true })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: true } });
  log.info('default split-inbox folders seeded');
}

/**
 * Notify every admin/owner about a channel transition (down or recovered).
 * Fires only on TRANSITIONS — a bridge that stays down alerts once, not every
 * 60s heartbeat tick.
 */
async function notifyAdminsOfTransition(connectionId: string, inboxId: string, body: string) {
  const db = getDb();
  const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, inboxId) });
  // "Admin" now means "role grants system administration" — channel health is
  // an operational concern, so it goes to whoever can act on it.
  const active = await db.query.users.findMany({
    where: eq(users.status, 'active'),
    columns: { id: true },
    with: { role: { columns: { permissions: true } } },
  });
  const admins = active.filter((u) => roleGrants(u.role?.permissions, 'system.admin'));
  for (const a of admins) {
    await db.insert(notifications).values({
      userId: a.id,
      type: 'system',
      body: `${inbox?.name ?? 'iMessage'}: ${body}`,
    });
    await publishEvent({ type: 'notification', userId: a.id });
  }
  log.info({ connectionId, admins: admins.length, body }, 'channel transition alert sent');
}

async function heartbeat(connectionId: string) {
  const db = getDb();
  // Read the prior status first so we only alert on transitions.
  const prior = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
    columns: { status: true, inboxId: true, webhookVersion: true, contactsSyncedAt: true },
  });
  try {
    const { client } = await loadConnection(connectionId);
    const info = await client.serverInfo();
    await db
      .update(channelConnections)
      .set({
        status: 'connected',
        lastHeartbeatAt: new Date(),
        lastError: null,
        capabilities: {
          privateApi: Boolean(info.private_api),
          serverVersion: info.server_version,
          macosVersion: info.os_version,
          proxyService: info.proxy_service,
        },
      })
      .where(eq(channelConnections.id, connectionId));
    await publishEvent({ type: 'connection.status', connectionId, status: 'connected' });

    if (prior && prior.status !== 'connected' && prior.status !== 'pending') {
      // Anything parked while the Mac was unreachable should go out NOW, not
      // after the rest of its backoff — the laptop is awake again.
      const flushed = await flushParkedSends(connectionId);
      await notifyAdminsOfTransition(
        connectionId,
        prior.inboxId,
        flushed > 0
          ? `bridge recovered — sending ${flushed} queued message${flushed === 1 ? '' : 's'}`
          : 'bridge recovered — messages are flowing again',
      ).catch(() => {});
    }

    // Self-heal a stale webhook subscription: an install created before an
    // event type was added would otherwise never receive it.
    if ((prior?.webhookVersion ?? 0) < COMMS_WEBHOOK_VERSION) {
      await enqueueMaintenance({ type: 'reregister', connectionId }).catch(() => {});
    }
  } catch (err) {
    // Store the human explanation, not the raw "fetch failed" — this string
    // is what the operator reads on the connection card and in the alert.
    const conn = await db.query.channelConnections.findFirst({
      where: eq(channelConnections.id, connectionId),
      columns: { serverUrl: true },
    });
    const explained = describeConnectionError(err, conn?.serverUrl);

    await db
      .update(channelConnections)
      .set({ status: 'error', lastError: explained })
      .where(eq(channelConnections.id, connectionId));
    await publishEvent({ type: 'connection.status', connectionId, status: 'error' });
    log.warn({ connectionId, err: (err as Error).message }, 'heartbeat failed');

    if (prior && prior.status === 'connected') {
      await notifyAdminsOfTransition(
        connectionId,
        prior.inboxId,
        `bridge DOWN — messages are NOT being received. ${explained}`,
      ).catch(() => {});
    }
  }
}

/**
 * Reconcile messages the webhook may have missed.
 *
 * The naive version asked the Mac for the messages of EVERY chat on every run
 * — 500 sequential HTTP requests against a machine that might be a laptop.
 * That saturated the bridge and caused the heartbeat to time out, which then
 * looked like the Mac going offline.
 *
 * `queryChats` already returns each chat's last message, so a chat with no
 * activity since our last sync can be skipped without asking about it. On a
 * quiet interval this drops from 500 requests to zero.
 */
async function backfill(connectionId: string, since?: number) {
  const db = getDb();
  const { client, connection } = await loadConnection(connectionId);
  const after = since ?? connection.lastSyncedAt?.getTime();

  const chats = await client.queryChats({ limit: 500, with: ['lastMessage', 'participants'] });

  const stale = after
    ? chats.filter((chat) => {
        const last = (chat as { lastMessage?: { dateCreated?: number } }).lastMessage;
        // No timestamp available → can't rule it out, so check it.
        if (!last?.dateCreated) return true;
        return last.dateCreated > after;
      })
    : chats;

  log.info(
    { connectionId, chats: chats.length, checking: stale.length },
    'backfill: fetched chats',
  );

  let ingested = 0;
  for (const chat of stale) {
    try {
      const msgs = await client.getChatMessages(chat.guid, {
        after,
        limit: 200,
        sort: 'ASC',
        with: ['attachment', 'handle'],
      });
      for (const m of msgs) {
        // ingestNewMessage dedups by provider guid, so re-runs are safe.
        // `??` would keep an EMPTY array, leaving chats[0] undefined and
        // making ingest drop the message as "not from a chat".
        const msgChats = m.chats?.length ? m.chats : [chat];
        // The message query returns chats without participants; the chat query
        // above asked for them. Carry them over, or ingest can't name a group.
        const first = msgChats[0];
        if (first && first.guid === chat.guid && !first.participants?.length) {
          msgChats[0] = { ...first, participants: chat.participants };
        }
        await ingestNewMessage(connectionId, { ...m, chats: msgChats });
        ingested += 1;
      }
    } catch (err) {
      log.warn({ chat: chat.guid, err: (err as Error).message }, 'backfill chat failed');
    }
  }

  if (ingested > 0) log.info({ connectionId, ingested }, 'backfill: ingested messages');

  await db
    .update(channelConnections)
    .set({ lastSyncedAt: new Date() })
    .where(eq(channelConnections.id, connectionId));
}

/**
 * Follow-up reminders: resurface conversations the customer never replied to.
 *
 * The distinction from a snooze is the whole point — if `lastInboundAt` moved
 * past `followUpArmedAt`, the customer DID reply, so the reminder resolves
 * silently. You're only ever interrupted about actual silence.
 */
async function followUps() {
  const db = getDb();
  const due = await db
    .update(conversations)
    .set({ followUpAt: null, followUpArmedAt: null })
    .where(and(isNotNull(conversations.followUpAt), lte(conversations.followUpAt, new Date())))
    .returning({
      id: conversations.id,
      inboxId: conversations.inboxId,
      number: conversations.number,
      status: conversations.status,
      lastInboundAt: conversations.lastInboundAt,
      armedAt: conversations.followUpArmedAt,
      userId: conversations.followUpUserId,
    });

  for (const c of due) {
    const customerReplied =
      c.lastInboundAt && c.armedAt && c.lastInboundAt.getTime() > c.armedAt.getTime();
    if (customerReplied) continue; // resolved itself — stay quiet

    if (c.status === 'closed' || c.status === 'snoozed') {
      await db
        .update(conversations)
        .set({ status: 'open', snoozedUntil: null })
        .where(eq(conversations.id, c.id));
    }

    await db.insert(messages).values({
      conversationId: c.id,
      direction: 'outbound',
      authorType: 'system',
      body: 'Follow-up reminder — the customer never replied',
      status: 'sent',
      sentAt: new Date(),
    });

    if (c.userId) {
      await db.insert(notifications).values({
        userId: c.userId,
        type: 'assignment',
        conversationId: c.id,
        body: `No reply yet on #${c.number} — time to follow up`,
      });
      await publishEvent({ type: 'notification', userId: c.userId });
    }
    await publishEvent({ type: 'conversation.updated', conversationId: c.id, inboxId: c.inboxId });
  }
}

/**
 * Nudges: promises we made and then went quiet on.
 *
 * Scans each conversation's LAST outbound agent reply (a later reply means
 * the earlier promise was superseded), runs the commitment detector over it,
 * and once the promised time has passed with no further reply from us, pins
 * a nudge on the conversation and tells the person who made the promise.
 *
 * Unlike a follow-up reminder, nobody set anything: the sentence itself was
 * the reminder. Dismissals are remembered per message, so the same promise
 * never nags twice.
 */
const NUDGE_WINDOW_DAYS = 14;
/** How long an undated promise ("I'll send that over") gets before a nudge. */
const NUDGE_DEFAULT_GRACE_MS = 3 * 24 * 3600_000;

async function nudgeSweep() {
  const db = getDb();

  // Last agent reply per conversation within the window, only where nothing
  // outbound followed it — SQL keeps the candidate set tiny before the
  // commitment detector (regex, per-row) runs in Node.
  const candidates = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      body: messages.body,
      authorUserId: messages.authorUserId,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, 'outbound'),
        eq(messages.authorType, 'agent'),
        eq(messages.isPrivateNote, false),
        isNotNull(messages.body),
        sql`${messages.createdAt} > now() - interval '${sql.raw(String(NUDGE_WINDOW_DAYS))} days'`,
        sql`${conversations.status} <> 'closed'`,
        sql`not exists (
          select 1 from ${messages} m2
          where m2.conversation_id = ${messages.conversationId}
            and m2.direction = 'outbound'
            and m2.author_type = 'agent'
            and m2.is_private_note = false
            and m2.created_at > ${messages.createdAt}
        )`,
      ),
    )
    .limit(500);

  const now = Date.now();
  for (const c of candidates) {
    const madeAt = c.sentAt ?? c.createdAt;
    const commitment = detectCommitment(c.body, madeAt);
    if (!commitment) continue;

    const dueAt = commitment.dueAt ?? new Date(madeAt.getTime() + NUDGE_DEFAULT_GRACE_MS);
    if (dueAt.getTime() > now) continue;

    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, c.conversationId),
      columns: { id: true, inboxId: true, number: true, metadata: true },
    });
    if (!conv) continue;

    const meta = (conv.metadata ?? {}) as Record<string, unknown>;
    const existing = meta.nudge as { messageId?: string } | undefined;
    // Already nudged (or dismissed) for this exact promise — stay quiet.
    if (existing?.messageId === c.messageId) continue;

    await db
      .update(conversations)
      .set({
        metadata: {
          ...meta,
          nudge: {
            messageId: c.messageId,
            excerpt: commitment.excerpt,
            dueAt: dueAt.toISOString(),
            firedAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(conversations.id, conv.id));

    if (c.authorUserId) {
      await db.insert(notifications).values({
        userId: c.authorUserId,
        type: 'system',
        conversationId: conv.id,
        body: `You said “${commitment.excerpt.slice(0, 80)}” on #${conv.number} — still unsent`,
      });
      await publishEvent({ type: 'notification', userId: c.authorUserId });
    }
    await publishEvent({
      type: 'conversation.updated',
      conversationId: conv.id,
      inboxId: conv.inboxId,
    });
    log.info({ conversationId: conv.id, messageId: c.messageId }, 'nudge fired');
  }
}

/**
 * One-time backfill: classify conversations that existed before the
 * correspondent detector did.
 *
 * Every pre-existing row defaults to `person`, so without this the split
 * inbox is empty on an established install until new traffic happens to
 * arrive — a folder called "Verification codes" that contains nothing is
 * indistinguishable from a broken feature.
 *
 * Bulk-loads each page's signals in three queries rather than three per
 * conversation, and is naturally idempotent: the classifier's escape hatches
 * (named contact, we replied, group) return `person` for anything already
 * correct, so a re-run changes nothing.
 */
async function classifyExisting() {
  const db = getDb();
  const done = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, KIND_BACKFILL_KEY),
  });
  if (done?.value) return;

  const PAGE = 200;
  let offset = 0;
  let updated = 0;

  for (;;) {
    const page = await db.query.conversations.findMany({
      columns: {
        id: true,
        providerChatGuid: true,
        isGroup: true,
        kind: true,
        contactId: true,
      },
      orderBy: [asc(conversations.createdAt)],
      limit: PAGE,
      offset,
    });
    if (page.length === 0) break;
    offset += page.length;

    const ids = page.map((c) => c.id);

    // Three bulk queries for the whole page: recent inbound bodies, which
    // conversations we have replied in, and which contacts have names.
    const [inbound, replied, named] = await Promise.all([
      db
        .select({
          conversationId: messages.conversationId,
          body: messages.body,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(inArray(messages.conversationId, ids), eq(messages.direction, 'inbound')))
        .orderBy(desc(messages.createdAt))
        .limit(ids.length * 8),
      db
        .selectDistinct({ conversationId: messages.conversationId })
        .from(messages)
        .where(
          and(
            inArray(messages.conversationId, ids),
            eq(messages.direction, 'outbound'),
            eq(messages.isPrivateNote, false),
            ne(messages.authorType, 'system'),
          ),
        ),
      db
        .select({ id: contacts.id, displayName: contacts.displayName })
        .from(contacts)
        .where(
          inArray(
            contacts.id,
            page.map((c) => c.contactId).filter((v): v is string => Boolean(v)),
          ),
        ),
    ]);

    const bodiesBy = new Map<string, string[]>();
    for (const m of inbound) {
      const list = bodiesBy.get(m.conversationId) ?? [];
      if (list.length < 5) list.push(m.body ?? '');
      bodiesBy.set(m.conversationId, list);
    }
    const repliedIn = new Set(replied.map((r) => r.conversationId));
    const nameById = new Map(named.map((n) => [n.id, n.displayName]));

    for (const c of page) {
      const kind = classifyCorrespondent({
        address: addressFromChatGuid(c.providerChatGuid),
        hasContactName: Boolean(c.contactId && nameById.get(c.contactId)?.trim()),
        inboundBodies: bodiesBy.get(c.id) ?? [],
        hasOutbound: repliedIn.has(c.id),
        isGroup: c.isGroup,
      });
      if (kind === c.kind) continue;
      await db.update(conversations).set({ kind }).where(eq(conversations.id, c.id));
      updated += 1;
    }

    if (page.length < PAGE) break;
  }

  await db
    .insert(appSettings)
    .values({ key: KIND_BACKFILL_KEY, value: true })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: true } });
  log.info({ updated }, 'classified pre-existing conversations');
}

async function unsnooze() {
  const db = getDb();
  const due = await db
    .update(conversations)
    .set({ status: 'open', snoozedUntil: null })
    .where(
      and(
        eq(conversations.status, 'snoozed'),
        lte(conversations.snoozedUntil, new Date()),
      ),
    )
    .returning({ id: conversations.id, inboxId: conversations.inboxId });

  for (const c of due) {
    await publishEvent({ type: 'conversation.updated', conversationId: c.id, inboxId: c.inboxId });
  }
}

/**
 * Delete and re-create the webhook. Needed after a URL change, and whenever
 * COMMS_WEBHOOK_EVENTS grows — re-POSTing an existing webhook URL is a silent
 * no-op on the BlueBubbles side, so old installs would never subscribe to
 * newly-added event types.
 */
async function reregisterWebhook(connectionId: string) {
  const db = getDb();
  const { client, connection } = await loadConnection(connectionId);
  const cfg = loadConfig();

  const existing = await client.listWebhooks().catch(() => [] as { id: number | string; url: string }[]);
  for (const hook of existing) {
    if (hook.url?.includes(`/api/webhooks/bluebubbles/${connectionId}`)) {
      await client.deleteWebhook(hook.id).catch(() => {});
    }
  }

  const url = `${cfg.appUrl}/api/webhooks/bluebubbles/${connectionId}?secret=${connection.webhookSecret}`;
  const hook = await client.registerWebhook(url, COMMS_WEBHOOK_EVENTS);
  await db
    .update(channelConnections)
    .set({
      providerWebhookId: String(hook.id),
      webhookVersion: COMMS_WEBHOOK_VERSION,
      lastError: null,
    })
    .where(eq(channelConnections.id, connectionId));
  log.info({ connectionId, version: COMMS_WEBHOOK_VERSION }, 'webhook re-registered');
}

/**
 * Promote every delayed outbound job for this connection so parked replies go
 * out the moment the bridge is back, rather than sitting out a 15-minute
 * backoff that was sized for an outage that just ended.
 */
async function flushParkedSends(connectionId: string): Promise<number> {
  try {
    const delayed = await outboundQueue().getDelayed(0, 500);
    let promoted = 0;
    for (const job of delayed) {
      if (job.data?.connectionId !== connectionId) continue;
      await job.promote().catch(() => {});
      promoted += 1;
    }
    if (promoted > 0) log.info({ connectionId, promoted }, 'flushed parked outbound sends');
    return promoted;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not flush parked sends');
    return 0;
  }
}

async function contactSync(connectionId: string) {
  const result = await syncContacts(connectionId);
  if (!result.macContactsVisible && result.fetched === 0) {
    log.warn(
      { connectionId },
      'contact sync returned nothing — BlueBubbles may lack macOS Contacts permission',
    );
  }
}

export async function processMaintenance(job: Job<MaintenanceJob>): Promise<void> {
  const data = job.data;
  switch (data.type) {
    case 'heartbeat':
      return heartbeat(data.connectionId);
    case 'reregister':
      return reregisterWebhook(data.connectionId);
    case 'contactSync':
      return contactSync(data.connectionId);
    case 'backfill':
      return backfill(data.connectionId, data.since);
    case 'unsnooze':
      // Same tick: due snoozes wake, due follow-ups resurface.
      await unsnooze();
      return followUps();
    case 'sla':
      return checkSlaBreaches();
    case 'repairNames':
      return repairBlankNames();
    case 'repairContacts':
      await repairContactlessConversations();
      await backfillParticipants();
      return;
    case 'nudges':
      return nudgeSweep();
    case 'classifyExisting':
      return classifyExisting();
    case 'seedDefaultFolders':
      return seedDefaultFolders();
  }
}
