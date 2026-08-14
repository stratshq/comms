'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The apps that are actually being built, named — so "coming soon" is a
 * commitment with an order, not a shrug. Cards become install buttons as
 * each integration lands.
 */
const CATALOGUE: { category: string; apps: { name: string; hint: string }[] }[] = [
  {
    category: 'CRM',
    apps: [
      { name: 'Twenty', hint: 'Sync contacts and conversations to the open-source CRM.' },
      { name: 'HubSpot', hint: 'Contacts, deals and timeline events, both ways.' },
      { name: 'Attio', hint: 'Threads on the record, records in the panel.' },
      { name: 'Salesforce', hint: 'Log conversations against leads and cases.' },
    ],
  },
  {
    category: 'Chat',
    apps: [
      { name: 'Slack', hint: 'Notifications in a channel; reply without leaving Slack.' },
      { name: 'Discord', hint: 'Route conversations into a server channel.' },
    ],
  },
];

function AppCard({ name, hint }: { name: string; hint: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5 opacity-80">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-[13px] font-bold text-muted-foreground">
        {name[0]}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {name}
          <span className="rounded bg-secondary px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Coming soon
          </span>
        </p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

export function AppsTab() {
  return (
    <div className="space-y-5">
      {CATALOGUE.map((group) => (
        <Card key={group.category}>
          <CardHeader>
            <CardTitle className="text-base">{group.category}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {group.apps.map((app) => (
              <AppCard key={app.name} name={app.name} hint={app.hint} />
            ))}
          </CardContent>
        </Card>
      ))}
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        These are the integrations being built, in the order shown. The platform layer underneath
        them — a sidebar-apps framework rendering your CRM&apos;s record inside the contact panel,
        plus outbound webhooks — is the same work, so each one gets cheaper than the last.
      </p>
    </div>
  );
}
