'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The apps that are actually being built, named — so "coming soon" is a
 * commitment with an order, not a shrug. Cards become install buttons as
 * each integration lands.
 */
interface AppEntry {
  name: string;
  /** Used for the favicon; also the obvious place to link once it ships. */
  domain: string;
  hint: string;
}

const CATALOGUE: { category: string; apps: AppEntry[] }[] = [
  {
    category: 'CRM',
    apps: [
      {
        name: 'Twenty',
        domain: 'twenty.com',
        hint: 'Sync contacts and conversations to the open-source CRM.',
      },
      {
        name: 'HubSpot',
        domain: 'hubspot.com',
        hint: 'Contacts, deals and timeline events, both ways.',
      },
      { name: 'Attio', domain: 'attio.com', hint: 'Threads on the record, records in the panel.' },
      {
        name: 'Salesforce',
        domain: 'salesforce.com',
        hint: 'Log conversations against leads and cases.',
      },
    ],
  },
  {
    category: 'Chat',
    apps: [
      {
        name: 'Slack',
        domain: 'slack.com',
        hint: 'Notifications in a channel; reply without leaving Slack.',
      },
      {
        name: 'Discord',
        domain: 'discord.com',
        hint: 'Route conversations into a server channel.',
      },
    ],
  },
];

/**
 * Each vendor's own favicon, with the initial tile as the fallback.
 *
 * Fetched from the vendor rather than bundled: brand marks get redrawn and a
 * stale copy checked into the repo is worse than none. The fallback matters
 * more than usual here — a self-hosted instance may be air-gapped or behind a
 * proxy that blocks the request, and this page must not render broken images
 * when it does.
 */
function AppIcon({ name, domain }: { name: string; domain: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-[13px] font-bold text-muted-foreground">
        {name[0]}
      </div>
    );
  }

  return (
    <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border bg-surface">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://${domain}/favicon.ico`}
        alt=""
        width={18}
        height={18}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-[18px] w-[18px] object-contain"
      />
    </div>
  );
}

function AppCard({ app }: { app: AppEntry }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5">
      <AppIcon name={app.name} domain={app.domain} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {app.name}
          <span className="rounded bg-secondary px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Coming soon
          </span>
        </p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{app.hint}</p>
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
              <AppCard key={app.name} app={app} />
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
