'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bell,
  Building2,
  Inbox,
  Keyboard,
  Radio,
  ShieldCheck,
  Sparkles,
  Tag,
  User,
  Users,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Settings navigation.
 *
 * This was a single horizontal tab strip. Eleven destinations plus their
 * section labels needed roughly 880px inside a 768px column, and the strip
 * hid its own scrollbar — so the last entries, Admin panel among them, were
 * simply invisible on a normal laptop with nothing on screen suggesting they
 * existed. A vertical list has room for every entry, groups them by what they
 * govern, and still collapses to a scrollable row on a phone.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  /** Omitted for personal settings, which everyone can reach. */
  permission?: string;
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Account',
    items: [
      { href: '/settings/profile', label: 'Profile', icon: User },
      { href: '/settings/inbox', label: 'Inbox', icon: Inbox },
      { href: '/settings/preferences', label: 'Preferences', icon: Bell },
      { href: '/settings/keyboard', label: 'Shortcuts', icon: Keyboard },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { href: '/settings/workspace', label: 'General', icon: Building2, permission: 'workspace.manage' },
      { href: '/settings/inboxes', label: 'Inboxes & Channels', icon: Radio, permission: 'inboxes.manage' },
      { href: '/settings/team', label: 'People', icon: Users, permission: 'users.manage' },
      { href: '/settings/roles', label: 'Roles', icon: ShieldCheck, permission: 'roles.manage' },
      { href: '/settings/tags', label: 'Tags', icon: Tag, permission: 'workspace.manage' },
      { href: '/settings/macros', label: 'Macros', icon: Sparkles, permission: 'workspace.manage' },
      { href: '/settings/automations', label: 'Automations', icon: Zap, permission: 'automations.manage' },
    ],
  },
  {
    title: 'Instance',
    items: [
      { href: '/settings/admin', label: 'Admin panel', icon: Activity, permission: 'system.admin' },
    ],
  },
];

export function SettingsNav({ permissions }: { permissions: string[] }) {
  const pathname = usePathname();
  // Sub-pages (e.g. /settings/inboxes/setup) keep their parent entry lit.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const granted = (permission?: string) =>
    !permission || permissions.includes('*') || permissions.includes(permission);

  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => granted(i.permission)) }))
    .filter((g) => g.items.length > 0);

  return (
    <nav aria-label="Settings">
      {/* Wide: a vertical list with room for everything. */}
      <div className="hidden md:block">
        {groups.map((group) => (
          <div key={group.title} className="mb-4 last:mb-0">
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.title}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                    isActive(item.href)
                      ? 'bg-brand-muted font-medium text-brand'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <item.icon className="h-[15px] w-[15px] shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Narrow: one scrollable row. Group labels are dropped — on a phone the
          row is swiped, and the labels would eat the width the entries need. */}
      <div className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 pb-2 md:hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.flatMap((g) => g.items).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors',
              isActive(item.href)
                ? 'bg-brand-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0" />
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
