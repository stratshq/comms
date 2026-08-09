'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Yours: anyone signed in can change these, whatever their role. */
const PERSONAL = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/preferences', label: 'Preferences' },
  { href: '/settings/keyboard', label: 'Shortcuts' },
];

/**
 * The workspace's. Each tab names the permission that unlocks it, so a custom
 * role sees exactly the sections it can actually use — an Automations-only
 * role gets one admin tab, not seven it can't open.
 */
const ADMIN: { href: string; label: string; permission: string }[] = [
  { href: '/settings/workspace', label: 'Workspace', permission: 'workspace.manage' },
  { href: '/settings/inboxes', label: 'Inboxes & Channels', permission: 'inboxes.manage' },
  { href: '/settings/team', label: 'People', permission: 'users.manage' },
  { href: '/settings/roles', label: 'Roles', permission: 'roles.manage' },
  { href: '/settings/tags', label: 'Tags', permission: 'workspace.manage' },
  { href: '/settings/macros', label: 'Macros', permission: 'workspace.manage' },
  { href: '/settings/automations', label: 'Automations', permission: 'automations.manage' },
];

/** The instance's: version, providers, runtime config, health. */
const OTHER: { href: string; label: string; permission: string }[] = [
  { href: '/settings/admin', label: 'Admin panel', permission: 'system.admin' },
];

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
        active
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );
}

export function SettingsNav({ permissions }: { permissions: string[] }) {
  const pathname = usePathname();
  // Sub-pages (e.g. /settings/inboxes/setup) keep their parent tab lit.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const granted = (permission: string) =>
    permissions.includes('*') || permissions.includes(permission);

  const admin = ADMIN.filter((t) => granted(t.permission));
  const other = OTHER.filter((t) => granted(t.permission));

  return (
    <nav className="flex gap-1 overflow-x-auto border-b [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {PERSONAL.map((item) => (
        <Tab key={item.href} href={item.href} label={item.label} active={isActive(item.href)} />
      ))}

      {admin.length > 0 && (
        <>
          <span aria-hidden className="mx-2 my-2 w-px shrink-0 bg-border" />
          <span className="flex shrink-0 items-center pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Admin
          </span>
          {admin.map((item) => (
            <Tab key={item.href} href={item.href} label={item.label} active={isActive(item.href)} />
          ))}
        </>
      )}

      {other.length > 0 && (
        <>
          <span aria-hidden className="mx-2 my-2 w-px shrink-0 bg-border" />
          <span className="flex shrink-0 items-center pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Other
          </span>
          {other.map((item) => (
            <Tab key={item.href} href={item.href} label={item.label} active={isActive(item.href)} />
          ))}
        </>
      )}
    </nav>
  );
}
