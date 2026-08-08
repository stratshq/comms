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

/** The workspace's: owner/admin only, and hidden entirely from agents. */
const ADMIN = [
  { href: '/settings/workspace', label: 'Workspace' },
  { href: '/settings/inboxes', label: 'Inboxes & Channels' },
  { href: '/settings/team', label: 'People' },
  { href: '/settings/teams', label: 'Teams' },
  { href: '/settings/tags', label: 'Tags' },
  { href: '/settings/macros', label: 'Macros' },
  { href: '/settings/automations', label: 'Automations' },
];

/** The instance's: version, providers, runtime config, health. */
const OTHER = [{ href: '/settings/admin', label: 'Admin panel' }];

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

export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  // Sub-pages (e.g. /settings/inboxes/setup) keep their parent tab lit.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="flex gap-1 overflow-x-auto border-b [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {PERSONAL.map((item) => (
        <Tab key={item.href} {...item} active={isActive(item.href)} />
      ))}

      {isAdmin && (
        <>
          <span aria-hidden className="mx-2 my-2 w-px shrink-0 bg-border" />
          <span className="flex shrink-0 items-center pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Admin
          </span>
          {ADMIN.map((item) => (
            <Tab key={item.href} {...item} active={isActive(item.href)} />
          ))}

          <span aria-hidden className="mx-2 my-2 w-px shrink-0 bg-border" />
          <span className="flex shrink-0 items-center pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Other
          </span>
          {OTHER.map((item) => (
            <Tab key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </>
      )}
    </nav>
  );
}
