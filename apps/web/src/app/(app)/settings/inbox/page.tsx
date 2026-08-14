import { resolvePreferences } from '@comms/db';
import { requireDbUser } from '@/lib/session';
import { InboxPreferences } from '@/components/settings/inbox-preferences';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function InboxSettingsPage() {
  const me = await requireDbUser();
  const prefs = resolvePreferences(me.preferences);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Inbox</h2>
        <p className="text-sm text-muted-foreground">
          How your list is laid out and ordered. Nobody else&rsquo;s inbox changes.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reading &amp; ordering</CardTitle>
        </CardHeader>
        <CardContent>
          <InboxPreferences
            inboxLayout={prefs.inboxLayout}
            focusAutoAdvance={prefs.focusAutoAdvance}
            pinnedFirst={prefs.pinnedFirst}
            unpinOnDone={prefs.unpinOnDone}
          />
        </CardContent>
      </Card>
    </div>
  );
}
