import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MessagesSquare, Plug } from 'lucide-react';
import { resolvePreferences } from '@comms/db';
import { listInboxes } from '@/server/queries';
import { requireDbUser } from '@/lib/session';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export default async function InboxEmptyPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const [{ list }, user] = await Promise.all([searchParams, requireDbUser()]);

  /**
   * Fullscreen layout: /inbox with nothing open means "start working", and
   * for these people that is Focus, not a placeholder pane.
   *
   * `?list=1` is the way back — it's what Focus's exit link points at, so
   * leaving Focus doesn't immediately re-enter it. Only the empty state
   * redirects; an actual conversation URL always opens the thread.
   */
  if (list !== '1' && resolvePreferences(user.preferences).inboxLayout === 'fullscreen') {
    redirect('/focus');
  }

  const inboxes = await listInboxes();
  const hasConnection = inboxes.some((i) => i.connections.length > 0);

  return (
    <div className="relative flex h-full flex-1 items-center justify-center overflow-hidden p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50 dark:opacity-25"
        style={{
          backgroundImage: 'radial-gradient(hsl(var(--border-strong)) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse 60% 50% at 50% 50%, black, transparent)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 50% at 50% 50%, black, transparent)',
        }}
      />

      <div className="relative max-w-[340px] animate-slide-up text-center">
        {hasConnection ? (
          <>
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border bg-surface shadow-sm">
              <MessagesSquare className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Select a conversation</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Choose one from the list to start replying, or press{' '}
              <kbd className="rounded border bg-secondary px-1 py-px font-sans text-[11px]">⌘K</kbd>{' '}
              to search.
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Plug className="h-5 w-5" />
            </div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Connect your iMessage</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Comms works through a Mac you leave running. We&apos;ll walk you through it step by
              step — about fifteen minutes, no technical experience needed.
            </p>
            <Button asChild className="mt-5">
              <Link href="/settings/inboxes/setup">Start guided setup</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
