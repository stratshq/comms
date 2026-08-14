'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Clock, Images, MessageSquare, UsersRound } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { setContactTeam, restoreContactTeam } from '@/server/actions/teams';
import { localTimeForAddress } from '@/lib/area-code-time';
import { formatAddress } from '@/lib/naming';
import { relativeTime } from '@/lib/format';
import { undoToast } from '@/lib/undo';
import { cn, initials } from '@/lib/utils';

const NO_TEAM = '__no_team__';

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
  /** Null for a thread with no linked contact — nothing to own. */
  contactId?: string | null;
  /** The team that owns this client; inherited by every future thread. */
  ownerTeamId?: string | null;
  teams?: { id: string; name: string; color: string }[];
}

/**
 * Who you are talking to.
 *
 * This sits above the ticket controls because it answers the question you
 * actually have when a thread opens. The workflow state — assignee, priority,
 * SLA — is something you already know, because you are the one looking at it.
 */
export function PersonCard(p: PersonCardProps) {
  const router = useRouter();
  const [, start] = useTransition();
  const primary = p.addresses[0];
  const local = localTimeForAddress(primary?.raw ?? primary?.value);
  const teams = p.teams ?? [];

  /**
   * Route the CLIENT, not the thread. Their open conversations move now and
   * everything they send later inherits it — so this is done once per client
   * rather than once per conversation.
   */
  function assignTeam(next: string | null) {
    if (!p.contactId) return;
    const contactId = p.contactId;
    start(async () => {
      const res = await setContactTeam(contactId, next);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const team = teams.find((t) => t.id === next);
      const moved = res.moved.length;
      undoToast(
        next ? `${p.name} is now a ${team?.name ?? 'team'} client` : `${p.name} has no team`,
        () => restoreContactTeam(contactId, res.previousOwnerTeamId, res.moved),
        {
          description:
            moved > 0
              ? `${moved} open conversation${moved === 1 ? '' : 's'} moved too. New ones follow automatically.`
              : 'New conversations from them will route here automatically.',
          onUndone: () => router.refresh(),
        },
      );
      router.refresh();
    });
  }

  // Two messages a week reads better than "104 messages", which is a number
  // nobody converts into a feeling about the relationship.
  const perWeek = p.recentMessages > 0 ? Math.round((p.recentMessages / 90) * 7 * 10) / 10 : 0;

  return (
    <div className="px-4 pb-4 pt-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-12 w-12 ring-1 ring-border">
          {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt={p.name} />}
          <AvatarFallback className="type-item bg-secondary font-semibold text-muted-foreground">
            {initials(p.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="type-title truncate">{p.name}</p>
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

      {/* Which team owns this client. Set once; every thread they ever start
          inherits it, which is the whole difference from tagging a thread. */}
      {p.contactId && teams.length > 0 && !p.isGroup && (
        <div className="mt-3.5">
          <p className="type-micro mb-1.5 flex items-center gap-1.5 text-muted-foreground/60">
            <UsersRound className="h-3 w-3" />
            Owned by
          </p>
          <Select
            value={p.ownerTeamId ?? NO_TEAM}
            onValueChange={(v) => assignTeam(v === NO_TEAM ? null : v)}
          >
            <SelectTrigger className="h-8 text-[12.5px]">
              <SelectValue placeholder="No team" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TEAM}>No team</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="type-caption mt-1 text-muted-foreground/70">
            Applies to every conversation with them, including new ones.
          </p>
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
