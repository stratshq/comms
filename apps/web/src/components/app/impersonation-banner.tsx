'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, X } from 'lucide-react';
import { stopImpersonation } from '@/server/actions/impersonation';

/**
 * A permanent, unmissable strip across the top of every page while a view-as
 * session is running.
 *
 * Deliberately loud and never dismissible: the entire danger of impersonation
 * is forgetting you are in it, and a banner you can close is a banner that
 * will be closed.
 */
export function ImpersonationBanner({
  viewingAs,
  actorName,
}: {
  viewingAs: string;
  actorName: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex shrink-0 items-center gap-2 bg-warning px-3 py-1.5 text-warning-foreground">
      <Eye className="h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
        Viewing as <span className="font-semibold">{viewingAs}</span> — read only. Signed in as{' '}
        {actorName}.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await stopImpersonation();
            router.push('/settings/admin?tab=general');
            router.refresh();
          })
        }
        className="flex shrink-0 items-center gap-1 rounded-md bg-warning-foreground/10 px-2 py-0.5 text-[12px] font-semibold transition-colors hover:bg-warning-foreground/20 disabled:opacity-60"
      >
        <X className="h-3 w-3" />
        {pending ? 'Stopping…' : 'Stop viewing'}
      </button>
    </div>
  );
}
