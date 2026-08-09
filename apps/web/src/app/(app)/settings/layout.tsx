import { isElevated, requireDbUser } from '@/lib/session';
import { SettingsNav } from '@/components/app/settings-nav';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const me = await requireDbUser();
  const elevated = isElevated(me);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {elevated
            ? 'Manage your account, and the workspace, channels, and people.'
            : 'Manage your account and how Comms works for you.'}
        </p>
        <div className="mt-6">
          <SettingsNav permissions={me.permissions} />
          <div className="py-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
