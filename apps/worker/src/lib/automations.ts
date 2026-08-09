import { getDb, eq, and, asc, sql } from '@comms/db';
import {
  automationRules,
  conversations,
  messages,
  conversationTags,
  contacts,
  appSettings,
  inboxes,
  type AutomationConditions,
} from '@comms/db';
import {
  publishEvent,
  enqueueOutbound,
  newTempGuid,
  renderTemplate,
  firstNameOf,
  logger,
} from '@comms/core';

const log = logger.child({ module: 'automations' });

type Trigger = 'conversation_created' | 'message_received';

export interface BusinessHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Minutes from midnight, workspace-local (see `timezone`). */
  startMinutes: number;
  endMinutes: number;
  timezone?: string;
}

const DEFAULT_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
};

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Is `now` inside the workspace's configured business hours? */
export function isWithinBusinessHours(hours: BusinessHours, now = new Date()): boolean {
  // Read the wall clock in the configured zone without pulling in a tz library.
  let day = now.getDay();
  let minutes = now.getHours() * 60 + now.getMinutes();

  if (hours.timezone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: hours.timezone,
          weekday: 'short',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        })
          .formatToParts(now)
          .map((p) => [p.type, p.value]),
      );
      day = DAY_INDEX[String(parts.weekday)] ?? day;
      // 'hour24' can render midnight as 24; normalise it.
      minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    } catch {
      // Unknown timezone string — fall back to server local time.
    }
  }

  if (!hours.days.includes(day)) return false;
  return minutes >= hours.startMinutes && minutes < hours.endMinutes;
}

async function getBusinessHours(): Promise<BusinessHours> {
  const row = await getDb().query.appSettings.findFirst({
    where: eq(appSettings.key, 'business_hours'),
  });
  return { ...DEFAULT_HOURS, ...((row?.value as Partial<BusinessHours>) ?? {}) };
}

export interface AutomationContext {
  bodyText?: string | null;
  /** Evaluate conditions but apply nothing — used by the rule tester. */
  dryRun?: boolean;
}

/** Evaluate one rule's conditions. Exported so the dry-run tester shares it. */
export function conditionsMatch(
  conditions: AutomationConditions,
  conv: Pick<typeof conversations.$inferSelect, 'inboxId' | 'priority' | 'kind'>,
  ctx: { bodyText?: string | null; tagIds: string[]; contactConversationCount: number },
  hours: BusinessHours,
  now = new Date(),
): boolean {
  const body = (ctx.bodyText ?? '').toLowerCase();

  const keywords = conditions.bodyContains ?? [];
  if (keywords.length > 0) {
    const hit = keywords.some((k) => k.trim() && body.includes(k.toLowerCase().trim()));
    if (!hit) return false;
  }

  if (conditions.inboxId && conv.inboxId !== conditions.inboxId) return false;

  if (conditions.priorityIn?.length && !conditions.priorityIn.includes(conv.priority)) {
    return false;
  }

  if (conditions.kindIn?.length && !conditions.kindIn.includes(conv.kind)) return false;

  if (conditions.hasTagIds?.length) {
    const owned = new Set(ctx.tagIds);
    if (!conditions.hasTagIds.every((t) => owned.has(t))) return false;
  }

  if (conditions.contactIs === 'first_time' && ctx.contactConversationCount > 1) return false;
  if (conditions.contactIs === 'returning' && ctx.contactConversationCount <= 1) return false;

  if (conditions.businessHours) {
    const inside = isWithinBusinessHours(hours, now);
    if (conditions.businessHours === 'inside' && !inside) return false;
    if (conditions.businessHours === 'outside' && inside) return false;
  }

  return true;
}

/** Loop guard: at most one auto-reply per conversation per hour. */
async function canAutoReply(conversationId: string): Promise<boolean> {
  const recent = await getDb().query.messages.findFirst({
    where: and(
      eq(messages.conversationId, conversationId),
      sql`${messages.metadata}->>'autoReply' = 'true'`,
      sql`${messages.createdAt} > now() - interval '1 hour'`,
    ),
  });
  return !recent;
}

/** Queue an automated reply through the normal outbound path. */
async function sendAutoReply(
  conv: typeof conversations.$inferSelect,
  template: string,
  ruleName: string,
): Promise<void> {
  const db = getDb();

  if (!(await canAutoReply(conv.id))) {
    log.info({ conversationId: conv.id }, 'auto-reply suppressed by loop guard');
    return;
  }

  let contactName: string | null = null;
  if (conv.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, conv.contactId),
      columns: { optedOutAt: true, displayName: true },
    });
    // Never message someone who replied STOP.
    if (contact?.optedOutAt) {
      log.info({ conversationId: conv.id }, 'auto-reply skipped: contact opted out');
      return;
    }
    contactName = contact?.displayName ?? null;
  }

  const connection = await db.query.channelConnections.findFirst({
    where: (c, { eq: e }) => e(c.inboxId, conv.inboxId),
  });
  if (!connection) return;

  const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, conv.inboxId) });
  const body = renderTemplate(template, {
    contact: { name: contactName, first_name: firstNameOf(contactName) },
    ticket: { number: conv.number, status: conv.status },
    inbox: { name: inbox?.name ?? null },
  });

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: 'outbound',
      authorType: 'system',
      body,
      status: 'queued',
      tempGuid: newTempGuid(),
      metadata: { autoReply: 'true', rule: ruleName },
    })
    .returning();

  if (msg) {
    await enqueueOutbound({
      messageId: msg.id,
      conversationId: conv.id,
      connectionId: connection.id,
    });
  }
}

/**
 * Evaluate enabled automation rules for a trigger and apply matching actions.
 * Rules run in sortOrder; a matching rule with `stopProcessing` ends the chain.
 * Returns the ids that fired so the dry-run tester can report them.
 */
export async function runAutomations(
  trigger: Trigger,
  conversationId: string,
  ctx: AutomationContext,
): Promise<{ firedRuleIds: string[] }> {
  const db = getDb();
  const rules = await db.query.automationRules.findMany({
    where: and(eq(automationRules.enabled, true), eq(automationRules.trigger, trigger)),
    orderBy: [asc(automationRules.sortOrder)],
  });
  if (rules.length === 0) return { firedRuleIds: [] };

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) return { firedRuleIds: [] };

  // Everything the conditions need, fetched once for all rules.
  const tagRows = await db
    .select({ tagId: conversationTags.tagId })
    .from(conversationTags)
    .where(eq(conversationTags.conversationId, conversationId));
  const tagIds = tagRows.map((t) => t.tagId);

  let contactConversationCount = 1;
  if (conv.contactId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(conversations)
      .where(eq(conversations.contactId, conv.contactId));
    contactConversationCount = Number(row?.n ?? 1);
  }

  const hours = await getBusinessHours();
  const firedRuleIds: string[] = [];

  for (const rule of rules) {
    const matched = conditionsMatch(
      rule.conditions ?? {},
      conv,
      { bodyText: ctx.bodyText, tagIds, contactConversationCount },
      hours,
    );
    if (!matched) continue;

    firedRuleIds.push(rule.id);
    if (ctx.dryRun) {
      if (rule.stopProcessing) break;
      continue;
    }

    const a = rule.actions ?? {};
    const patch: Partial<typeof conversations.$inferInsert> = {};
    if (a.setStatus) patch.status = a.setStatus;
    if (a.setPriority) patch.priority = a.setPriority;
    if (a.assignToUserId !== undefined) patch.assigneeId = a.assignToUserId;
    if (a.mute) patch.mutedAt = new Date();
    if (a.snoozeMinutes) {
      patch.status = 'snoozed';
      patch.snoozedUntil = new Date(Date.now() + a.snoozeMinutes * 60_000);
    }
    if (a.slaMinutes) {
      patch.nextResponseDueAt = new Date(Date.now() + a.slaMinutes * 60_000);
      patch.slaBreachedAt = null;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(conversations).set(patch).where(eq(conversations.id, conversationId));
    }

    for (const tagId of a.addTagIds ?? []) {
      await db.insert(conversationTags).values({ conversationId, tagId }).onConflictDoNothing();
    }

    if (a.autoReply?.trim()) {
      await sendAutoReply(conv, a.autoReply, rule.name).catch((err) =>
        log.warn({ err: (err as Error).message, ruleId: rule.id }, 'auto-reply failed'),
      );
    }

    await db.insert(messages).values({
      conversationId,
      direction: 'outbound',
      authorType: 'system',
      body: `Automation "${rule.name}" applied`,
      status: 'sent',
      sentAt: new Date(),
    });

    // Observability: rules that fire invisibly are rules nobody trusts.
    await db
      .update(automationRules)
      .set({
        fireCount: sql`${automationRules.fireCount} + 1`,
        lastFiredAt: new Date(),
        lastConversationNumber: conv.number,
      })
      .where(eq(automationRules.id, rule.id));

    await publishEvent({ type: 'conversation.updated', conversationId, inboxId: conv.inboxId });
    log.info({ ruleId: rule.id, conversationId }, 'automation applied');

    if (rule.stopProcessing) break;
  }

  return { firedRuleIds };
}
