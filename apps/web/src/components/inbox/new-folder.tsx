'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { KeyRound, Bot, UserRound, Folder, SlidersHorizontal, Star } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createSavedView } from '@/server/actions/views';
import { QueryBuilder } from '@/components/inbox/query-builder';
import type { ViewFilters } from '@comms/db';
import { describeQuery, sanitizeQuery, type FolderQuery } from '@comms/db/query';
import { cn } from '@/lib/utils';

/**
 * One dialog for making a folder.
 *
 * Before this, "put OTP messages in their own folder" meant creating a tag,
 * writing an automation to apply it, filtering the inbox by it, and saving
 * that filter as a view — four screens for one idea. Here it's a name, a
 * source, and a place to put it.
 *
 * Membership stays computed: the folder is a filter, so it is correct the
 * instant it is created and stays correct without anything running.
 */

type SourceKind =
  | { type: 'kind'; value: 'unknown' | 'automated' | 'otp' | 'person' }
  | { type: 'tag'; value: string }
  | { type: 'inbox'; value: string }
  | { type: 'words'; value: string }
  | { type: 'query'; value: FolderQuery }
  | null;

/** What the advanced builder starts with — one empty row, not zero. */
const EMPTY_QUERY: FolderQuery = { match: 'all', conditions: [{ field: 'kind', operator: 'is', value: '' }] };

/** One-tap starting points — the folders nearly every workspace wants. */
const PRESETS: {
  key: string;
  name: string;
  icon: React.ElementType;
  source: SourceKind;
  display: 'sidebar' | 'section';
  hint: string;
}[] = [
  {
    key: 'otp',
    name: 'Verification codes',
    icon: KeyRound,
    source: { type: 'kind', value: 'otp' },
    display: 'section',
    hint: '2FA and login codes',
  },
  {
    key: 'automated',
    name: 'Automated',
    icon: Bot,
    source: { type: 'kind', value: 'automated' },
    display: 'section',
    hint: 'Delivery notices, alerts',
  },
  {
    key: 'unknown',
    name: 'Unknown numbers',
    icon: UserRound,
    source: { type: 'kind', value: 'unknown' },
    display: 'section',
    hint: 'Nobody you know yet',
  },
  {
    key: 'important',
    name: 'Important',
    icon: Star,
    // The split every inbox starts with: what a person sent you, at a
    // priority someone raised, or a thread you pinned. Everything it does not
    // claim falls into the list's "Other" section underneath it.
    source: {
      type: 'query',
      value: {
        match: 'any',
        conditions: [
          { field: 'priority', operator: 'is', value: 'urgent' },
          { field: 'priority', operator: 'is', value: 'high' },
          { field: 'pinned', operator: 'is', value: 'true' },
          { field: 'assignee', operator: 'is', value: 'me' },
        ],
      },
    },
    display: 'section',
    hint: 'Urgent, pinned, or yours',
  },
];

export function NewFolderDialog({
  tags,
  inboxes,
  agents = [],
}: {
  tags: { id: string; name: string; color: string }[];
  inboxes: { id: string; name: string }[];
  /** Offered as assignee values in the advanced builder. */
  agents?: { id: string; name: string | null; email: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState<SourceKind>(null);
  const [display, setDisplay] = useState<'sidebar' | 'section'>('sidebar');
  const [pending, start] = useTransition();

  useEffect(() => {
    const onOpen = () => {
      setName('');
      setSource(null);
      setDisplay('sidebar');
      setOpen(true);
    };
    window.addEventListener('comms:new-folder', onOpen);
    return () => window.removeEventListener('comms:new-folder', onOpen);
  }, []);

  function filtersFor(s: SourceKind): ViewFilters {
    if (!s) return {};
    switch (s.type) {
      case 'kind':
        return { kind: s.value };
      case 'tag':
        return { tagIds: [s.value] };
      case 'inbox':
        return { inboxId: s.value };
      case 'words':
        return {
          bodyContains: s.value
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean),
        };
      case 'query':
        return { query: s.value };
    }
  }

  function create(overrides?: { name: string; source: SourceKind; display: 'sidebar' | 'section' }) {
    const finalName = (overrides?.name ?? name).trim();
    const finalSource = overrides?.source ?? source;
    const finalDisplay = overrides?.display ?? display;
    if (!finalName || !finalSource) return;

    const filters = filtersFor(finalSource);
    if (finalSource.type === 'words' && !filters.bodyContains?.length) {
      toast.error('Add at least one word to match.');
      return;
    }
    // A half-filled condition is dropped by `sanitizeQuery`, which would turn
    // "urgent and unread" into a folder that quietly claims the whole inbox.
    // Better to say so than to create it.
    if (finalSource.type === 'query' && !sanitizeQuery(finalSource.value)) {
      toast.error('Give every condition a value.');
      return;
    }

    start(async () => {
      const res = await createSavedView({
        name: finalName,
        display: finalDisplay,
        // Folders live over the inbox, not over closed history.
        filters: { ...filters, status: 'active' },
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        finalDisplay === 'sidebar'
          ? `"${finalName}" added to the sidebar`
          : `"${finalName}" now groups the inbox`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  const canCreate = Boolean(name.trim() && source);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-muted text-brand">
              <Folder className="h-3.5 w-3.5" />
            </span>
            New folder
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Presets first: most people want one of these four and nothing else. */}
          <div>
            <p className="type-micro mb-1.5 text-muted-foreground/70">Start from</p>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    create({ name: p.name, source: p.source, display: p.display })
                  }
                  className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-all hover:border-border-strong hover:bg-accent active:scale-[0.98] disabled:opacity-60"
                >
                  <p.icon className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">
                      {p.hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="h-px bg-border" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface px-2 text-[10.5px] uppercase tracking-wide text-muted-foreground/60">
              or build one
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Enterprise clients"
            />
          </div>

          <div className="space-y-1.5">
            <Label>What goes in it</Label>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <Chip
                  key={`tag-${t.id}`}
                  active={source?.type === 'tag' && source.value === t.id}
                  color={t.color}
                  onClick={() => setSource({ type: 'tag', value: t.id })}
                >
                  {t.name}
                </Chip>
              ))}
              {inboxes.length > 1 &&
                inboxes.map((i) => (
                  <Chip
                    key={`inbox-${i.id}`}
                    active={source?.type === 'inbox' && source.value === i.id}
                    onClick={() => setSource({ type: 'inbox', value: i.id })}
                  >
                    {i.name}
                  </Chip>
                ))}
            </div>

            <Input
              value={source?.type === 'words' ? source.value : ''}
              onChange={(e) => setSource({ type: 'words', value: e.target.value })}
              placeholder="…or words in the message: invoice, receipt, refund"
              className="mt-1 text-[12.5px]"
            />

            {/* The advanced builder stays folded away. One chip or one word
                covers most folders, and a grid of dropdowns sitting open
                makes the simple case look like the hard one. */}
            {source?.type === 'query' ? (
              <div className="mt-2 rounded-lg border bg-secondary/40 p-2.5">
                <QueryBuilder
                  query={source.value}
                  onChange={(q) => setSource({ type: 'query', value: q })}
                  tags={tags}
                  inboxes={inboxes}
                  agents={agents}
                />
                {sanitizeQuery(source.value) && (
                  <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">
                    Contains conversations where{' '}
                    <span className="text-foreground">
                      {describeQuery(sanitizeQuery(source.value)!)}
                    </span>
                    .
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSource({ type: 'query', value: EMPTY_QUERY })}
                className="mt-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SlidersHorizontal className="h-3 w-3" />
                …or build a rule with and / or
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Show as</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { key: 'sidebar', label: 'Sidebar row', hint: 'A place to navigate to' },
                  { key: 'section', label: 'Inbox section', hint: 'Grouped in the list' },
                ] as const
              ).map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setDisplay(o.key)}
                  className={cn(
                    'rounded-lg border px-2.5 py-2 text-left transition-all active:scale-[0.98]',
                    display === o.key
                      ? 'border-brand bg-brand-muted'
                      : 'hover:border-border-strong hover:bg-accent',
                  )}
                >
                  <span
                    className={cn(
                      'block text-[12.5px] font-medium',
                      display === o.key && 'text-brand',
                    )}
                  >
                    {o.label}
                  </span>
                  <span className="block text-[10.5px] text-muted-foreground">{o.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => create()} loading={pending} disabled={!canCreate}>
            Create folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Chip({
  children,
  active,
  color,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-all active:scale-95',
        active
          ? 'border-brand bg-brand-muted text-brand'
          : 'text-muted-foreground hover:border-border-strong hover:bg-accent',
      )}
    >
      <span className="flex items-center gap-1.5">
        {color && (
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        )}
        {children}
      </span>
    </button>
  );
}
