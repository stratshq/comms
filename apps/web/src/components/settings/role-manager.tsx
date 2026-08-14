'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Lock, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createRole, deleteRole, updateRole, type RoleRow } from '@/server/actions/roles';
import { cn } from '@/lib/utils';

type PermissionInfo = { key: string; label: string; description: string };

/**
 * One row per permission with a checkbox. Used both by the create form and by
 * each editable role card, so granting reads identically everywhere.
 */
function PermissionPicker({
  catalog,
  selected,
  onToggle,
  disabled = false,
}: {
  catalog: PermissionInfo[];
  selected: string[];
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      {catalog.map((p) => {
        const on = selected.includes(p.key);
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(p.key)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
              on ? 'border-brand bg-brand-muted/60' : 'hover:border-border-strong hover:bg-accent',
            )}
          >
            <span
              className={cn(
                'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors',
                on ? 'border-brand bg-brand text-primary-foreground' : 'border-border-strong',
              )}
            >
              {on && <Check className="h-3 w-3" />}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-[12.5px] font-medium', on && 'text-brand')}>
                {p.label}
              </span>
              <span className="block text-[11px] leading-snug text-muted-foreground">
                {p.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RoleCard({
  role,
  catalog,
}: {
  role: RoleRow;
  catalog: PermissionInfo[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(role.name);
  const isOwner = role.permissions.includes('*');

  function toggle(key: string) {
    const next = role.permissions.includes(key)
      ? role.permissions.filter((k) => k !== key)
      : [...role.permissions, key];
    start(async () => {
      const res = await updateRole({ id: role.id, permissions: next });
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });
  }

  function rename() {
    const next = name.trim();
    if (!next || next === role.name) {
      setName(role.name);
      return;
    }
    start(async () => {
      const res = await updateRole({ id: role.id, name: next });
      if (!res.ok) {
        toast.error(res.error);
        setName(role.name);
      }
      router.refresh();
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteRole(role.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${role.name}" deleted`);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border bg-surface p-4 shadow-xs">
      <div className="flex items-center gap-2">
        {role.isSystem ? (
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
            {isOwner ? <ShieldCheck className="h-3.5 w-3.5" /> : <Lock className="h-3 w-3 text-muted-foreground" />}
            {role.name}
          </span>
        ) : (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className="h-7 w-44 text-[13.5px] font-medium"
          />
        )}
        <span className="ml-auto flex items-center gap-1 text-[11.5px] text-muted-foreground">
          <Users className="h-3 w-3" />
          {role.memberCount} {role.memberCount === 1 ? 'person' : 'people'}
        </span>
        {!role.isSystem && (
          <button
            onClick={remove}
            disabled={pending}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
            aria-label={`Delete ${role.name}`}
            title={role.memberCount > 0 ? 'Move its members to another role first' : 'Delete role'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {role.description && (
        <p className="mt-1 text-[12px] text-muted-foreground">{role.description}</p>
      )}

      <div className="mt-3">
        {isOwner ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
            Every permission, always — including ones added later. This role is not editable, so a
            workspace can never lock itself out.
          </p>
        ) : (
          <PermissionPicker
            catalog={catalog}
            selected={role.permissions}
            onToggle={toggle}
            disabled={pending}
          />
        )}
      </div>
    </div>
  );
}

export function RoleManager({
  roles,
  catalog,
  callerIsOwner,
}: {
  roles: RoleRow[];
  catalog: PermissionInfo[];
  /** Owners see the Owner card first; everyone else manages the editable ones. */
  callerIsOwner: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  function submit() {
    start(async () => {
      const res = await createRole({ name, description, permissions: selected });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${name.trim()}" created — assign people to it from the People page`);
      setName('');
      setDescription('');
      setSelected([]);
      setShowForm(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {roles.map((r) => (
        <RoleCard key={r.id} role={r} catalog={catalog} />
      ))}
      {!callerIsOwner && (
        <p className="text-[11.5px] text-muted-foreground">
          Only an owner can assign or revoke the Owner role.
        </p>
      )}

      {!showForm ? (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          New role
        </Button>
      ) : (
        <div className="space-y-3.5 rounded-xl border bg-surface p-4 shadow-xs">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Supervisor"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">Description (optional)</Label>
            <Input
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Permissions</Label>
            <PermissionPicker
              catalog={catalog}
              selected={selected}
              onToggle={(key) =>
                setSelected((prev) =>
                  prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
                )
              }
            />
            <p className="text-[11px] text-muted-foreground">
              No permissions ticked means inbox access only — same as Agent.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={submit} loading={pending} disabled={!name.trim()}>
              Create role
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
