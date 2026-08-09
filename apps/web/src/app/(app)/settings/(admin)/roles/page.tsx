import { requirePermissionPage } from '@/lib/session';
import { listRoles } from '@/server/actions/roles';
import { PERMISSIONS, WILDCARD_PERMISSION } from '@comms/db';
import { RoleManager } from '@/components/settings/role-manager';

export const dynamic = 'force-dynamic';

export default async function RolesSettingsPage() {
  const me = await requirePermissionPage('roles.manage');
  const roles = await listRoles();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Roles</h2>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          What each kind of user is allowed to do. Everyone can work the inbox; a role decides
          which parts of the workspace they can also administer. Assign people to roles from the
          People page.
        </p>
      </div>

      <RoleManager
        roles={roles}
        catalog={PERMISSIONS.map((p) => ({ ...p }))}
        callerIsOwner={me.permissions.includes(WILDCARD_PERMISSION)}
      />

      <div className="rounded-xl border bg-surface-sunken p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">How roles work</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <span className="text-foreground">Owner</span> always has every permission — including
            ones added in future versions — and can never be edited or deleted.
          </li>
          <li>
            <span className="text-foreground">Admin</span> and{' '}
            <span className="text-foreground">Agent</span> are built in but customizable: tick or
            untick permissions to change what they grant everywhere, instantly.
          </li>
          <li>
            Custom roles let you shape access precisely — for example a &ldquo;Supervisor&rdquo;
            who manages automations and shared folders but not people or channels.
          </li>
        </ul>
      </div>
    </div>
  );
}
