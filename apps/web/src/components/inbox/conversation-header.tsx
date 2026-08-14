'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, RotateCcw, Clock, ChevronLeft, PanelRight, Bell, BellOff, Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { updateConversation, setFollowUp, setMuted } from '@/server/actions/inbox';
import { setPinned, togglePin } from '@/server/actions/pins';
import { PresenceBar } from '@/components/inbox/presence-bar';
import { SNOOZE_PRESETS, FOLLOW_UP_PRESETS } from '@/lib/snooze';
import { CustomTimePicker } from '@/components/inbox/time-picker';
import { describeTime } from '@/lib/parse-time';
import { siblingConversationId } from '@/lib/inbox-nav';
import { undoToast } from '@/lib/undo';
import { cn } from '@/lib/utils';

/** Status is a dot + label rather than a filled chip — quieter in a header. */
const STATUS_DOT: Record<string, string> = {
  open: 'bg-success',
  pending: 'bg-warning',
  snoozed: 'bg-muted-foreground',
  closed: 'bg-muted-foreground/60',
};

export function ConversationHeader({
  conversationId,
  number,
  name,
  status: serverStatus,
  muted: serverMuted = false,
  pinned: serverPinned = false,
}: {
  conversationId: string;
  number: number;
  name: string;
  status: string;
  muted?: boolean;
  /** Whether the signed-in user pinned this thread. Personal, not shared. */
  pinned?: boolean;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  // Optimistic status: flips instantly on click, server props reconcile later.
  const [status, setStatus] = useState(serverStatus);
  const [muted, setMutedLocal] = useState(serverMuted);
  const [pinned, setPinnedLocal] = useState(serverPinned);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  useEffect(() => setStatus(serverStatus), [serverStatus]);
  useEffect(() => setMutedLocal(serverMuted), [serverMuted]);
  useEffect(() => setPinnedLocal(serverPinned), [serverPinned]);

  // The global `s` shortcut opens the snooze menu for the open conversation.
  useEffect(() => {
    const open = () => setSnoozeOpen(true);
    window.addEventListener('comms:snooze-open', open);
    return () => window.removeEventListener('comms:snooze-open', open);
  }, []);

  function applyStatus(next: 'open' | 'closed') {
    const prev = status;
    const goNext = next === 'closed' ? advanceTarget() : null;
    setStatus(next);
    start(async () => {
      const res = await updateConversation({ id: conversationId, status: next });
      if (!res.ok) {
        setStatus(prev);
        toast.error(res.error);
      } else if (goNext !== null) {
        undoToast('Conversation closed', () =>
          updateConversation({ id: conversationId, status: prev as 'open' | 'pending' }),
        );
        router.push(goNext);
      } else {
        router.refresh();
      }
    });
  }

  function togglePinned() {
    const next = !pinned;
    setPinnedLocal(next);
    start(async () => {
      const res = await togglePin(conversationId);
      if (!res.ok) {
        setPinnedLocal(!next);
        toast.error(res.error);
        return;
      }
      undoToast(next ? 'Pinned to the top of your inbox' : 'Unpinned', () =>
        setPinned(conversationId, !next),
      { onUndone: () => { setPinnedLocal(!next); router.refresh(); } });
      router.refresh();
    });
  }

  function toggleMute() {
    const next = !muted;
    setMutedLocal(next);
    start(async () => {
      const res = await setMuted(conversationId, next);
      if (!res.ok) {
        setMutedLocal(!next);
        toast.error(res.error);
        return;
      }
      if (next) {
        undoToast('Muted — stays in place, stops notifying', () => setMuted(conversationId, false), {
          onUndone: () => {
            setMutedLocal(false);
            router.refresh();
          },
        });
      } else {
        toast.success('Unmuted');
      }
      router.refresh();
    });
  }

  /**
   * Where to land once this conversation leaves the current folder. Read BEFORE
   * the mutation, while the row is still in the list — afterwards there is no
   * "next to" anything.
   */
  function advanceTarget() {
    const next =
      siblingConversationId(conversationId, 1) ?? siblingConversationId(conversationId, -1);
    return next ? `/inbox/${next}` : '/inbox';
  }

  /**
   * A follow-up doesn't change status — it just arms a reminder that resolves
   * itself silently if the customer writes back.
   */
  function followUp(until: Date, label: string) {
    setSnoozeOpen(false);
    start(async () => {
      const res = await setFollowUp(conversationId, until.toISOString());
      if (!res.ok) toast.error(res.error);
      else
        undoToast(`We'll bump this ${label.toLowerCase()} if they don't reply`, () =>
          setFollowUp(conversationId, null),
        );
    });
  }

  function snooze(until: Date, label: string) {
    const prev = status;
    // Snoozing takes the conversation out of the inbox, so staying on it would
    // leave you looking at something that is no longer in the list you came
    // from. Same move the `e` shortcut makes when closing.
    const goNext = advanceTarget();
    setStatus('snoozed');
    setSnoozeOpen(false);
    start(async () => {
      const res = await updateConversation({
        id: conversationId,
        status: 'snoozed',
        snoozedUntil: until.toISOString(),
      });
      if (!res.ok) {
        setStatus(prev);
        toast.error(res.error);
      } else {
        undoToast(`Snoozed until ${label.toLowerCase()}`, () =>
          updateConversation({
            id: conversationId,
            status: (prev === 'closed' ? 'open' : prev) as 'open' | 'pending',
            snoozedUntil: null,
          }),
        );
        router.push(goNext);
      }
    });
  }

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b bg-surface/80 px-2.5 backdrop-blur-xl md:gap-4 md:px-4">
      <div className="flex min-w-0 items-center gap-2 md:gap-2.5">
        <Link
          href="/inbox"
          className="-ml-0.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          aria-label="Back to conversations"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em]">{name}</h1>
        <span className="tabular hidden shrink-0 rounded-md bg-secondary px-1.5 py-px font-mono text-[11px] text-muted-foreground sm:inline">
          #{number}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] capitalize text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} />
          {status}
        </span>
        {muted && (
          <span
            className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground"
            title="Muted — no unread badge, no notifications"
          >
            <BellOff className="h-3 w-3" />
            <span className="hidden sm:inline">muted</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        <div className="hidden sm:block">
          <PresenceBar conversationId={conversationId} />
        </div>

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={togglePinned}
          aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
          aria-pressed={pinned}
          title={
            pinned
              ? 'Unpin — back to normal order'
              : 'Pin — keeps this at the top of your inbox (yours only)'
          }
          className={cn(pinned && 'text-brand')}
        >
          <Pin className={cn('h-3.5 w-3.5', pinned && 'fill-current')} />
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute conversation' : 'Mute conversation'}
          title={
            muted
              ? 'Unmute — start counting unread again'
              : 'Mute — stays here, stops notifying (great for group chats)'
          }
          className={cn(muted && 'text-warning')}
        >
          {muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
        </Button>

        {status !== 'closed' && (
          <DropdownMenu open={snoozeOpen} onOpenChange={setSnoozeOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Snooze</span>
                <kbd className="ml-0.5 hidden rounded border bg-secondary px-1 text-[10px] text-muted-foreground md:inline">
                  s
                </kbd>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Snooze until…
              </DropdownMenuLabel>
              {SNOOZE_PRESETS.map((p) => {
                const when = p.until();
                return (
                  <DropdownMenuItem key={p.key} onClick={() => snooze(when, p.label)}>
                    <span className="flex-1">{p.label}</span>
                    <span className="tabular text-[11px] text-muted-foreground">
                      {when.toLocaleDateString(undefined, { weekday: 'short' })}{' '}
                      {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </DropdownMenuItem>
                );
              })}

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Remind me if no reply…
              </DropdownMenuLabel>
              {FOLLOW_UP_PRESETS.map((p) => (
                <DropdownMenuItem key={p.key} onClick={() => followUp(p.until(), p.label)}>
                  {p.label}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Snooze until a specific time
              </DropdownMenuLabel>
              {/* onSelect is prevented so typing in here doesn't close the menu
                  on the first keystroke. */}
              <div onKeyDown={(e) => e.stopPropagation()}>
                <CustomTimePicker
                  onPick={(at) => snooze(at, describeTime(at))}
                  autoFocus={false}
                />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {status === 'closed' ? (
          <Button size="sm" variant="outline" onClick={() => applyStatus('open')}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reopen
          </Button>
        ) : (
          <Button size="sm" onClick={() => applyStatus('closed')}>
            <Check className="h-3.5 w-3.5" />
            Close
            <kbd className="ml-0.5 hidden rounded border border-primary-foreground/25 px-1 text-[10px] opacity-70 md:inline">
              e
            </kbd>
          </Button>
        )}

        {/* Ticket details live in a slide-over below lg. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('comms:toggle-details'))}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          aria-label="Ticket details"
        >
          <PanelRight className="h-[18px] w-[18px]" />
        </button>
      </div>
    </header>
  );
}
