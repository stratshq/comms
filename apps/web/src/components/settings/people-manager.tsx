'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { setUserRole } from '@/server/actions/roles';
import { initials } from '@/lib/utils';

export function PeopleManager({
  people,
  roles,
  currentUserId,
}: {
  people: { id: string; name: string | null; email: string; image: string | null; roleId: string; roleName: string }[];
  /** Roles the signed-in user is allowed to hand out. */
  roles: { id: string; name: string }[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const assignable = new Set(roles.map((r) => r.id));

  function changeRole(userId: string, roleId: string) {
    start(async () => {
      const res = await setUserRole(userId, roleId);
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success('Role updated — it applies on their next page load');
      }
      router.refresh();
    });
  }

  return (
    <div className="divide-y rounded-lg border">
      {people.map((a) => (
        <div key={a.id} className="flex items-center gap-3 p-3">
          <Avatar className="h-8 w-8">
            {a.image && <AvatarImage src={a.image} alt={a.name ?? ''} />}
            <AvatarFallback className="text-xs">{initials(a.name ?? a.email)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {a.name ?? a.email}
              {a.id === currentUserId && (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(you)</span>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">{a.email}</p>
          </div>
          {assignable.has(a.roleId) || assignable.size === 0 ? (
            <Select
              value={a.roleId}
              onValueChange={(v) => changeRole(a.id, v)}
              disabled={pending}
            >
              <SelectTrigger className="h-8 w-36 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            // A role the caller cannot hand out (Owner, for non-owners) renders
            // as a plain label rather than a select that would only error.
            <span className="rounded-md bg-secondary px-2.5 py-1 text-[12.5px] font-medium">
              {a.roleName}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
