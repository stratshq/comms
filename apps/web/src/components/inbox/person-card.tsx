'use client';

import Link from 'next/link';
import { Clock, Images, MessageSquare } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { localTimeForAddress } from '@/lib/area-code-time';
import { formatAddress } from '@/lib/naming';
import { relativeTime } from '@/lib/format';
import { cn, initials } from '@/lib/utils';

export interface PersonCardProps {
  name: string;
  avatarUrl?: string | null;
  addresses: { value: string; raw: string | null }[];
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  firstMessageAt: string | null;
  totalMessages: number;
  recentMessages: number;
  photos: { id: string; fileName: string | null }[];
  photoCount: number;
  isGroup: boolean;
  /** Null for a thread with no linked contact. */
  contactId?: string | null;
}

/**
 * Wraps a bit of the card in a link to the person's page — or doesn't, when
 * there is no contact row behind the thread. Rendering a dead link to
 * `/people/null` would look identical right up until someone clicked it.
 */
function PersonLink({
  contactId,
  label,
  className,
  children,
}: {
  contactId: string | null | undefined;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!contactId) return <>{children}</>;
  return (
    <Link
      href={`/people/${contactId}`}
      title={`Open ${label}'s profile`}
      className={cn('block shrink-0', className)}
    >
      {children}
    </Link>
  );
}

/**
 * Who you are talking to.
 *
 * This sits above the ticket controls because it answers the question you
 * actually have when a thread opens. The workflow state — assignee, priority,
 * SLA — is something you already know, because you are the one looking at it.
 */
export function PersonCard(p: PersonCardProps) {
  const primary = p.addresses[0];
  const local = localTimeForAddress(primary?.raw ?? primary?.value);

  // Two messages a week reads better than "104 messages", which is a number
  // nobody converts into a feeling about the relationship.
  const perWeek = p.recentMessages > 0 ? Math.round((p.recentMessages / 90) * 7 * 10) / 10 : 0;

  return (
    <div className="px-4 pb-4 pt-4">
      <div className="flex items-center gap-3">
        {/* Their face is the way into their page. A group has no single
            person behind it, so there it stays a picture. */}
        <PersonLink contactId={p.isGroup ? null : p.contactId} label={p.name}>
          <Avatar className="h-12 w-12 ring-1 ring-border">
            {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.name} />}
            <AvatarFallback className="type-item bg-secondary font-semibold text-muted-foreground">
              {initials(p.name)}
            </AvatarFallback>
          </Avatar>
        </PersonLink>
        <div className="min-w-0">
          <p className="type-title truncate">
            <PersonLink
              contactId={p.isGroup ? null : p.contactId}
              label={p.name}
              className="rounded transition-colors hover:text-brand"
            >
              {p.name}
            </PersonLink>
          </p>
          {local && (
            <p
              className={cn(
                'type-caption flex items-center gap-1',
                // Their 3am is the single most common way to be rude by text.
                local.unsociable ? 'text-warning' : 'text-muted-foreground',
              )}
              title={local.unsociable ? 'It may be a bad time to text' : 'Their local time'}
            >
              <Clock className="h-3 w-3" />
              {local.time} their time
            </p>
          )}
        </div>
      </div>

      {/* For a group, one member's number under the group name reads as THE
          number — the Members section in the panel is the honest answer. */}
      {!p.isGroup && p.addresses.length > 0 && (
        <div className="mt-3 space-y-0.5">
          {p.addresses.slice(0, 4).map((a) => (
            <p key={a.value} className="type-body truncate text-muted-foreground">
              {formatAddress(a.raw ?? a.value) ?? a.value}
            </p>
          ))}
          {p.addresses.length > 4 && (
            <p className="type-caption text-muted-foreground/70">
              +{p.addresses.length - 4} more
            </p>
          )}
        </div>
      )}

      <dl className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat label="Last heard from" value={p.lastInboundAt ? relativeTime(p.lastInboundAt) : '—'} />
        <Stat
          label="You two have been talking"
          value={p.firstMessageAt ? `since ${relativeTime(p.firstMessageAt)}` : '—'}
        />
        <Stat
          label="Messages"
          value={p.totalMessages ? p.totalMessages.toLocaleString() : '—'}
          icon={MessageSquare}
        />
        <Stat
          label="Lately"
          value={perWeek > 0 ? `${perWeek}/week` : 'quiet'}
        />
      </dl>

      {p.photos.length > 0 && (
        <div className="mt-4">
          <p className="type-micro mb-1.5 flex items-center gap-1.5 text-muted-foreground/60">
            <Images className="h-3 w-3" />
            Shared photos
            {p.photoCount > p.photos.length && (
              <span className="tabular normal-case tracking-normal">({p.photoCount})</span>
            )}
          </p>
          <div className="grid grid-cols-3 gap-1">
            {p.photos.map((a) => (
              <Link
                key={a.id}
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="group relative aspect-square overflow-hidden rounded-lg border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/attachments/${a.id}`}
                  alt={a.fileName ?? 'Shared photo'}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-300 ease-smooth group-hover:scale-105"
                />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="min-w-0">
      <dt className="type-caption truncate text-muted-foreground/70">{label}</dt>
      <dd className="type-item mt-px flex items-center gap-1 truncate">
        {Icon && <Icon className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
        {value}
      </dd>
    </div>
  );
}
