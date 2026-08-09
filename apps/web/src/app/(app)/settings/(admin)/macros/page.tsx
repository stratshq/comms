import { requirePermissionPage } from '@/lib/session';
import { listMacros } from '@/server/queries';
import { MacroManager } from '@/components/settings/macro-manager';

export const dynamic = 'force-dynamic';

export default async function MacrosSettingsPage() {
  await requirePermissionPage('workspace.manage');
  const macros = await listMacros();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Macros</h2>
        <p className="text-sm text-muted-foreground">
          Save canned responses your team can insert with one click.
        </p>
      </div>
      <MacroManager
        macros={macros.map((m) => ({
          id: m.id,
          name: m.name,
          body: m.body,
          shortcut: m.shortcut,
        }))}
      />
    </div>
  );
}
