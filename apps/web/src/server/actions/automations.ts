'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, sql } from '@comms/db';
import {
  automationRules,
  appSettings,
  type AutomationConditions,
  type AutomationActions,
} from '@comms/db';
import { db } from '@/server/db';
import { requirePermission, requirePermissionForRead } from '@/lib/session';
import { setSetting } from '@/server/settings';

export type RuleResult = { ok: true } | { ok: false; error: string };

export type RuleActions = AutomationActions;
export type RuleConditions = AutomationConditions;

export interface BusinessHoursSetting {
  days: number[];
  startMinutes: number;
  endMinutes: number;
  timezone?: string;
}

const DEFAULT_HOURS: BusinessHoursSetting = {
  days: [1, 2, 3, 4, 5],
  startMinutes: 540,
  endMinutes: 1020,
};

export async function createRule(input: {
  name: string;
  trigger: 'conversation_created' | 'message_received';
  conditions: RuleConditions;
  actions: RuleActions;
  stopProcessing?: boolean;
}): Promise<RuleResult> {
  await requirePermission('automations.manage');
  if (!input.name.trim()) return { ok: false, error: 'Name is required.' };

  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${automationRules.sortOrder}), 0)` })
    .from(automationRules);

  await db.insert(automationRules).values({
    name: input.name.trim(),
    trigger: input.trigger,
    conditions: {
      ...input.conditions,
      bodyContains: (input.conditions.bodyContains ?? []).map((s) => s.trim()).filter(Boolean),
    },
    actions: input.actions,
    stopProcessing: Boolean(input.stopProcessing),
    sortOrder: Number(maxRow?.max ?? 0) + 1,
  });
  revalidatePath('/settings/automations');
  return { ok: true };
}

export async function updateRule(
  id: string,
  patch: {
    name?: string;
    conditions?: RuleConditions;
    actions?: RuleActions;
    stopProcessing?: boolean;
    sortOrder?: number;
  },
): Promise<RuleResult> {
  await requirePermission('automations.manage');
  await db.update(automationRules).set(patch).where(eq(automationRules.id, id));
  revalidatePath('/settings/automations');
  return { ok: true };
}

export async function toggleRule(id: string, enabled: boolean): Promise<RuleResult> {
  await requirePermission('automations.manage');
  await db.update(automationRules).set({ enabled }).where(eq(automationRules.id, id));
  revalidatePath('/settings/automations');
  return { ok: true };
}

export async function deleteRule(id: string): Promise<RuleResult> {
  await requirePermission('automations.manage');
  await db.delete(automationRules).where(eq(automationRules.id, id));
  revalidatePath('/settings/automations');
  return { ok: true };
}

/** Move a rule up or down in evaluation order. */
export async function reorderRule(id: string, direction: 'up' | 'down'): Promise<RuleResult> {
  await requirePermission('automations.manage');
  const all = await db.query.automationRules.findMany({
    orderBy: [asc(automationRules.sortOrder)],
  });
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, error: 'Rule not found.' };
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= all.length) return { ok: true };

  const a = all[idx]!;
  const b = all[swapWith]!;
  await db
    .update(automationRules)
    .set({ sortOrder: b.sortOrder })
    .where(eq(automationRules.id, a.id));
  await db
    .update(automationRules)
    .set({ sortOrder: a.sortOrder })
    .where(eq(automationRules.id, b.id));
  revalidatePath('/settings/automations');
  return { ok: true };
}

export interface DryRunResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  reason: string;
  stoppedChain: boolean;
}

/** Business-hours check shared by the dry run (mirrors the worker's logic). */
function insideBusinessHours(hours: BusinessHoursSetting, now: Date): boolean {
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
      const map: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      day = map[String(parts.weekday)] ?? day;
      minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    } catch {
      /* fall back to server local time */
    }
  }
  return hours.days.includes(day) && minutes >= hours.startMinutes && minutes < hours.endMinutes;
}

/**
 * Test which rules a hypothetical message would fire, changing nothing.
 * Automations you can't test are automations you're afraid to edit.
 * Mirrors the worker's ordering and stop-processing behaviour.
 */
export async function dryRunRules(input: {
  trigger: 'conversation_created' | 'message_received';
  bodyText: string;
  inboxId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  tagIds?: string[];
  contactIsFirstTime?: boolean;
  kind?: 'person' | 'unknown' | 'automated' | 'otp';
  atTime?: string;
}): Promise<DryRunResult[]> {
  await requirePermissionForRead('automations.manage');

  const rules = await db.query.automationRules.findMany({
    where: and(eq(automationRules.enabled, true), eq(automationRules.trigger, input.trigger)),
    orderBy: [asc(automationRules.sortOrder)],
  });

  const hoursRow = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'business_hours'),
  });
  const hours: BusinessHoursSetting = {
    ...DEFAULT_HOURS,
    ...((hoursRow?.value as Partial<BusinessHoursSetting>) ?? {}),
  };
  const now = input.atTime ? new Date(input.atTime) : new Date();
  const inside = insideBusinessHours(hours, now);

  const body = input.bodyText.toLowerCase();
  const ownedTags = new Set(input.tagIds ?? []);
  const results: DryRunResult[] = [];
  let stopped = false;

  for (const rule of rules) {
    if (stopped) {
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        reason: 'skipped — an earlier rule stopped processing',
        stoppedChain: false,
      });
      continue;
    }

    const c = (rule.conditions ?? {}) as AutomationConditions;
    let matched = true;
    let reason = 'all conditions matched';

    const keywords = c.bodyContains ?? [];
    if (matched && keywords.length > 0) {
      const hit = keywords.some((k) => k.trim() && body.includes(k.toLowerCase().trim()));
      if (!hit) {
        matched = false;
        reason = `no keyword matched (${keywords.join(', ')})`;
      }
    }
    if (matched && c.inboxId && input.inboxId && c.inboxId !== input.inboxId) {
      matched = false;
      reason = 'different channel';
    }
    // The tester defaults to a person, which is what an operator is picturing
    // when they type a message into the box.
    if (matched && c.kindIn?.length && !c.kindIn.includes(input.kind ?? 'person')) {
      matched = false;
      reason = `sender is a ${input.kind ?? 'person'}, rule wants ${c.kindIn.join('/')}`;
    }
    if (
      matched &&
      c.priorityIn?.length &&
      input.priority &&
      !c.priorityIn.includes(input.priority)
    ) {
      matched = false;
      reason = `priority is ${input.priority}, rule wants ${c.priorityIn.join('/')}`;
    }
    if (matched && c.hasTagIds?.length && !c.hasTagIds.every((t) => ownedTags.has(t))) {
      matched = false;
      reason = 'required tags missing';
    }
    if (matched && c.contactIs === 'first_time' && input.contactIsFirstTime === false) {
      matched = false;
      reason = 'contact is a returning customer';
    }
    if (matched && c.contactIs === 'returning' && input.contactIsFirstTime === true) {
      matched = false;
      reason = 'contact is a first-time customer';
    }
    if (matched && c.businessHours) {
      if (c.businessHours === 'inside' && !inside) {
        matched = false;
        reason = 'outside business hours';
      } else if (c.businessHours === 'outside' && inside) {
        matched = false;
        reason = 'inside business hours';
      }
    }

    const stoppedChain = matched && rule.stopProcessing;
    if (stoppedChain) stopped = true;

    results.push({ ruleId: rule.id, ruleName: rule.name, matched, reason, stoppedChain });
  }

  return results;
}

export async function saveBusinessHours(input: BusinessHoursSetting): Promise<RuleResult> {
  await requirePermission('automations.manage');
  await setSetting('business_hours', input);
  revalidatePath('/settings/automations');
  return { ok: true };
}

export async function getBusinessHoursSetting(): Promise<BusinessHoursSetting> {
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.key, 'business_hours'),
  });
  return { ...DEFAULT_HOURS, ...((row?.value as Partial<BusinessHoursSetting>) ?? {}) };
}
