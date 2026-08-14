import { getDb, eq, and, inArray, count, asc, isNotNull } from '@comms/db';
import {
  conversations,
  users,
  inboxes,
  messages,
  notifications,
} from '@comms/db';
import { getRedis, publishEvent, logger } from '@comms/core';

const log = logger.child({ module: 'assign' });

/** Active agents who can receive assignments, in a stable order for round-robin. */
async function activeAgents() {
  const db = getDb();
  return db.query.users.findMany({
    where: eq(users.status, 'active'),
    columns: { id: true, name: true },
    orderBy: [asc(users.id)],
  });
}

async function pickAgent(
  inboxId: string,
  strategy: 'round_robin' | 'least_busy',
): Promise<{ id: string; name: string | null } | null> {
  const agents = await activeAgents();
  if (agents.length === 0) return null;

  if (strategy === 'least_busy') {
    const db = getDb();
    const rows = await db
      .select({ assigneeId: conversations.assigneeId, n: count() })
      .from(conversations)
      .where(
        and(
          isNotNull(conversations.assigneeId),
          inArray(conversations.status, ['open', 'pending', 'snoozed']),
        ),
      )
      .groupBy(conversations.assigneeId);
    const load = new Map(rows.map((r) => [r.assigneeId, Number(r.n)]));
    let best = agents[0]!;
    let min = Infinity;
    for (const a of agents) {
      const l = load.get(a.id) ?? 0;
      if (l < min) {
        min = l;
        best = a;
      }
    }
    return best;
  }

  // round_robin: monotonic counter per inbox, modulo the agent roster.
  const idx = await getRedis().incr(`comms:assign:rr:${inboxId}:all`);
  return agents[(idx - 1) % agents.length]!;
}

/**
 * Auto-assign a newly created conversation if the inbox enables it. No-op when
 * disabled, when already assigned, or when there are no active agents.
 */
export async function maybeAutoAssign(conversationId: string, inboxId: string): Promise<void> {
  const db = getDb();
  const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, inboxId) });
  if (!inbox?.settings?.autoAssign) return;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, assigneeId: true },
  });
  if (!conv || conv.assigneeId) return;

  const agent = await pickAgent(inboxId, inbox.settings.assignStrategy ?? 'round_robin');
  if (!agent) return;

  await db
    .update(conversations)
    .set({ assigneeId: agent.id })
    .where(eq(conversations.id, conversationId));

  await db.insert(messages).values({
    conversationId,
    direction: 'outbound',
    authorType: 'system',
    body: `Auto-assigned to ${agent.name ?? 'an agent'}`,
    status: 'sent',
    sentAt: new Date(),
  });

  await db.insert(notifications).values({
    userId: agent.id,
    type: 'assignment',
    conversationId,
    body: 'A conversation was auto-assigned to you',
  });

  await publishEvent({ type: 'conversation.updated', conversationId, inboxId });
  await publishEvent({ type: 'notification', userId: agent.id });
  log.info({ conversationId, agentId: agent.id }, 'auto-assigned');
}
