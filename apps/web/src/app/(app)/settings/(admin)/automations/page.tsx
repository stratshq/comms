import { requirePermissionPage } from '@/lib/session';
import {
  listAutomationRules,
  listAgents,
  listTags,
  listInboxes,
} from '@/server/queries';
import { AutomationManager } from '@/components/settings/automation-manager';
import { BusinessHoursForm } from '@/components/settings/business-hours-form';
import { getBusinessHoursSetting } from '@/server/actions/automations';

export const dynamic = 'force-dynamic';

export default async function AutomationsSettingsPage() {
  await requirePermissionPage('automations.manage');
  const [rules, agents, tags, inboxRows, hours] = await Promise.all([
    listAutomationRules(),
    listAgents(),
    listTags(),
    listInboxes(),
    getBusinessHoursSetting(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Automations</h2>
        <p className="text-sm text-muted-foreground">
          Automatically triage, route, tag, and reply when conversations arrive. Rules run top to
          bottom.
        </p>
      </div>

      <AutomationManager
        rules={rules.map((r) => ({
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          trigger: r.trigger,
          conditions: r.conditions,
          actions: r.actions,
          stopProcessing: r.stopProcessing,
          fireCount: r.fireCount,
          lastFiredAt: r.lastFiredAt,
          lastConversationNumber: r.lastConversationNumber,
        }))}
        agents={agents.map((a) => ({ id: a.id, name: a.name, email: a.email }))}
        allTags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        inboxes={inboxRows.map((i) => ({ id: i.id, name: i.name }))}
      />

      <div className="border-t pt-5">
        <h3 className="text-[15px] font-semibold">Business hours</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Used by the &ldquo;inside / outside business hours&rdquo; automation condition.
        </p>
        <div className="mt-3">
          <BusinessHoursForm initial={hours} />
        </div>
      </div>
    </div>
  );
}
