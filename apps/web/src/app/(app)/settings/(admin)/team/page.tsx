import { requirePermissionPage } from '@/lib/session';
import { listAgents } from '@/server/queries';
import { listAssignableRoles } from '@/server/actions/roles';
import { AddTeammate } from '@/components/settings/add-teammate';
import { PeopleManager } from '@/components/settings/people-manager';

export const dynamic = 'force-dynamic';

export default async function TeamSettingsPage() {
  const me = await requirePermissionPage('users.manage');
  const [agents, assignableRoles] = await Promise.all([listAgents(), listAssignableRoles()]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">People</h2>
          <p className="text-sm text-muted-foreground">
            Who has access to this workspace, and which role — and therefore which permissions —
            each person has.
          </p>
        </div>
        <AddTeammate roles={assignableRoles} />
      </div>

      <PeopleManager
        people={agents.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          image: a.image,
          roleId: a.roleId,
          roleName: a.role?.name ?? 'Agent',
        }))}
        roles={assignableRoles}
        currentUserId={me.id}
      />
    </div>
  );
}
