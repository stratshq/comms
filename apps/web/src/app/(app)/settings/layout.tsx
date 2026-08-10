import { isElevated, requireDbUser } from '@/lib/session';
import { SettingsNav } from '@/components/app/settings-nav';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const me = await requireDbUser();
  const elevated = isElevated(me);

  return (
    <div className="h-full overflow-y-auto">
      {/* Wider than the old single column: the nav now sits beside the content
          rather than above it, so the page itself keeps its readable width. */}
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {elevated
            ? 'Manage your account, and the workspace, channels, and people.'
            : 'Manage your account and how Comms works for you.'}
        </p>

        <div className="mt-6 flex flex-col gap-6 md:flex-row md:gap-8">
          <aside className="shrink-0 md:w-52">
            <div className="md:sticky md:top-0">
              <SettingsNav permissions={me.permissions} />
            </div>
          </aside>
          <div className="min-w-0 flex-1 pb-10">{children}</div>
        </div>
      </div>
    </div>
  );
}
