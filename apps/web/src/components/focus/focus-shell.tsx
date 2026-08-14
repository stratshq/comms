'use client';

import { useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, PartyPopper, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThreadShell } from '@/components/inbox/thread-shell';
import type { ThreadMessage } from '@/components/inbox/message-thread';
import type { MacroOption } from '@/components/inbox/macro-picker';
import type { SharedDraftItem } from '@/components/inbox/shared-drafts';
import type { BusinessHours } from '@/lib/availability';
import { updateConversation } from '@/server/actions/inbox';
import { undoToast } from '@/lib/undo';
import { cn } from '@/lib/utils';

export interface FocusThread {
  conversationId: string;
  number: number;
  name: string;
  status: string;
  messages: ThreadMessage[];
  macros: MacroOption[];
  aiEnabled: boolean;
  aiDraft: string | null;
  initialDraft: { body: string; isPrivateNote: boolean; shared?: boolean } | null;
  canReact: boolean;
  isAdmin: boolean;
  sharedDrafts: SharedDraftItem[];
  businessHours: BusinessHours;
  signaturePreview: string | null;
  viaInbox: { name: string; color: string } | null;
}

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

/**
 * Full-screen, one-at-a-time chrome around the ordinary thread + composer.
 *
 * No list, no sidebar, no details pane — one conversation and a counter.
 * Sending or closing advances the stack; `j`/`k` skip back and forth; Esc
 * returns to the inbox. The overlay sits above the app shell so the rest of
 * the product literally cannot pull at your attention.
 */
export function FocusShell({
  queueKey,
  queueLabel,
  ids,
  thread,
  autoAdvance = true,
  exitHref = '/inbox',
}: {
  queueKey: string;
  queueLabel: string;
  ids: string[];
  thread: FocusThread | null;
  /** Their preference: move to the next thread after a reply or a close. */
  autoAdvance?: boolean;
  /**
   * Where Esc and the exit button go. Normally the inbox — but for someone
   * whose inbox IS this screen, plain `/inbox` would bounce them straight
   * back here, so that case passes the list's own URL instead.
   */
  exitHref?: string;
}) {
  const router = useRouter();
  const index = thread ? ids.indexOf(thread.conversationId) : -1;
  const total = ids.length;

  const go = useCallback(
    (id: string | undefined) => {
      if (id) router.push(`/focus?queue=${queueKey}&c=${id}`);
    },
    [router, queueKey],
  );

  const advance = useCallback(() => {
    if (index === -1) return;
    const next = ids[index + 1];
    if (next) go(next);
    else {
      toast.success('Stack finished — nice work');
      router.push(exitHref);
    }
  }, [ids, index, go, router, exitHref]);

  const back = useCallback(() => {
    if (index > 0) go(ids[index - 1]);
  }, [ids, index, go]);

  /**
   * What happens after you act on the thread you're looking at.
   *
   * Advancing is the point of a stack, but it also means never seeing the
   * message you just sent — so it's a preference. With it off, the screen
   * stays put and j moves you on when you're ready.
   */
  const afterAction = useCallback(() => {
    if (autoAdvance) advance();
    else router.refresh();
  }, [autoAdvance, advance, router]);

  const closeAndAdvance = useCallback(() => {
    if (!thread) return;
    const id = thread.conversationId;
    const prev = thread.status as 'open' | 'pending';
    void updateConversation({ id, status: 'closed' }).then((res) => {
      if (!res.ok) toast.error(res.error);
      else undoToast('Closed', () => updateConversation({ id, status: prev }));
    });
    afterAction();
  }, [thread, afterAction]);

  // Focus mode owns the keyboard while it's up. The global shortcut listener
  // stands down on /focus (it navigates to /inbox routes), so this local
  // handler is the only one running.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && !isTyping()) {
        e.preventDefault();
        router.push(exitHref);
        return;
      }
      if (isTyping()) return;
      if (e.key === 'j' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'k' || e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      } else if (e.key === 'e') {
        e.preventDefault();
        closeAndAdvance();
      } else if (e.key === 'r') {
        e.preventDefault();
        window.dispatchEvent(new Event('comms:focus-composer'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, back, closeAndAdvance, router, exitHref]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Minimal top strip: exit, queue name, progress, prev/next. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-surface/80 px-3 backdrop-blur-xl">
        <Link
          href={exitHref}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Exit focus mode"
          title="Exit (Esc)"
        >
          <X className="h-4 w-4" />
        </Link>
        <span className="type-caption font-medium text-muted-foreground">{queueLabel}</span>

        {thread && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em]">
              {thread.name}
            </span>
            <span className="tabular hidden shrink-0 rounded-md bg-secondary px-1.5 py-px font-mono text-[11px] text-muted-foreground sm:inline">
              #{thread.number}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {total > 0 && index >= 0 && (
            <span className="tabular mr-1 text-[12px] font-medium text-muted-foreground">
              {index + 1} <span className="text-muted-foreground/50">of</span> {total}
            </span>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={back}
            disabled={index <= 0}
            aria-label="Previous (k)"
            title="Previous (k)"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={advance}
            disabled={index === -1}
            aria-label="Skip (j)"
            title="Skip (j)"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {thread && thread.status !== 'closed' && (
            <Button size="sm" onClick={closeAndAdvance} className="ml-1">
              <Check className="h-3.5 w-3.5" />
              Close
              <kbd className="ml-0.5 hidden rounded border border-primary-foreground/25 px-1 text-[10px] opacity-70 md:inline">
                e
              </kbd>
            </Button>
          )}
        </div>
      </header>

      {thread ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadShell
            conversationId={thread.conversationId}
            messages={thread.messages}
            macros={thread.macros}
            aiEnabled={thread.aiEnabled}
            aiDraft={thread.aiDraft}
            initialDraft={thread.initialDraft}
            canReact={thread.canReact}
            sharedDrafts={thread.sharedDrafts}
            isAdmin={thread.isAdmin}
            businessHours={thread.businessHours}
            signaturePreview={thread.signaturePreview}
            viaInbox={thread.viaInbox}
            onSent={afterAction}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className={cn('max-w-[340px] animate-slide-up text-center')}>
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
              <PartyPopper className="h-6 w-6" />
            </div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">The stack is clear</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Nothing left in {queueLabel.toLowerCase()}. That's the whole point of this screen.
            </p>
            <Button asChild className="mt-5">
              <Link href={exitHref}>Back to the inbox</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
