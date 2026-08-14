'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Columns2, Maximize2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { updateInboxPreferences } from '@/server/actions/profile';
import { cn } from '@/lib/utils';

type Layout = 'default' | 'fullscreen';

function Row({
  id,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * A layout choice is a picture, not a sentence. Two small diagrams of the
 * actual panes say more than "fullscreen" ever could, and they're what makes
 * the difference obvious before you commit to it.
 */
function LayoutCard({
  value,
  current,
  title,
  description,
  disabled,
  onSelect,
}: {
  value: Layout;
  current: Layout;
  title: string;
  description: string;
  disabled: boolean;
  onSelect: (v: Layout) => void;
}) {
  const active = current === value;
  const Icon = value === 'fullscreen' ? Maximize2 : Columns2;

  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex-1 rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
        active ? 'border-brand bg-brand-muted' : 'hover:bg-accent',
      )}
    >
      <div className="mb-2.5 flex h-14 gap-1 overflow-hidden rounded-lg border bg-surface p-1">
        {value === 'default' ? (
          <>
            <div className="w-1/3 space-y-1 rounded bg-secondary p-1">
              <div className="h-1.5 rounded-full bg-muted-foreground/25" />
              <div className="h-1.5 rounded-full bg-muted-foreground/25" />
              <div className="h-1.5 rounded-full bg-muted-foreground/25" />
            </div>
            <div className="flex-1 rounded bg-secondary/50" />
          </>
        ) : (
          <div className="flex-1 rounded bg-secondary/50" />
        )}
      </div>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className={cn('h-3.5 w-3.5', active ? 'text-brand' : 'text-muted-foreground')} />
        {title}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </button>
  );
}

export function InboxPreferences({
  inboxLayout,
  focusAutoAdvance,
  pinnedFirst,
  unpinOnDone,
}: {
  inboxLayout: Layout;
  focusAutoAdvance: boolean;
  pinnedFirst: boolean;
  unpinOnDone: boolean;
}) {
  const [layout, setLayout] = useState<Layout>(inboxLayout);
  const [autoAdvance, setAutoAdvance] = useState(focusAutoAdvance);
  const [pinFirst, setPinFirst] = useState(pinnedFirst);
  const [unpin, setUnpin] = useState(unpinOnDone);
  const [pending, start] = useTransition();

  function save(
    patch: Parameters<typeof updateInboxPreferences>[0],
    revert: () => void,
  ) {
    start(async () => {
      const res = await updateInboxPreferences(patch);
      if (!res.ok) {
        revert();
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium">Layout</p>
        <p className="mb-2.5 text-xs text-muted-foreground">
          What opening Comms puts on screen.
        </p>
        <div className="flex gap-2.5">
          <LayoutCard
            value="default"
            current={layout}
            title="List &amp; thread"
            description="The conversation list beside whatever you have open."
            disabled={pending}
            onSelect={(v) => {
              const prev = layout;
              setLayout(v);
              save({ inboxLayout: v }, () => setLayout(prev));
            }}
          />
          <LayoutCard
            value="fullscreen"
            current={layout}
            title="Fullscreen"
            description="One conversation at a time, no list. Opens straight into Focus."
            disabled={pending}
            onSelect={(v) => {
              const prev = layout;
              setLayout(v);
              save({ inboxLayout: v }, () => setLayout(prev));
            }}
          />
        </div>
      </div>

      <div className="space-y-4 border-t pt-5">
        <Row
          id="focus-auto-advance"
          title="Auto-advance in fullscreen"
          description="After you reply or close, move straight to the next conversation."
          checked={autoAdvance}
          disabled={pending}
          onChange={(v) => {
            setAutoAdvance(v);
            save({ focusAutoAdvance: v }, () => setAutoAdvance(!v));
          }}
        />
        <Row
          id="pinned-first"
          title="Pinned at the top"
          description="Conversations you pin float above the rest of your list. Pins are yours alone — nobody else's order changes."
          checked={pinFirst}
          disabled={pending}
          onChange={(v) => {
            setPinFirst(v);
            save({ pinnedFirst: v }, () => setPinFirst(!v));
          }}
        />
        <Row
          id="unpin-on-done"
          title="Unpin when done"
          description="Closing a conversation clears your pin. Turn this off to keep pins as long-lived bookmarks."
          checked={unpin}
          disabled={pending}
          onChange={(v) => {
            setUnpin(v);
            save({ unpinOnDone: v }, () => setUnpin(!v));
          }}
        />
      </div>
    </div>
  );
}
