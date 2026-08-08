'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronDown, ListFilter, Save, X, ArrowDownUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AnimatePresence, motion } from '@/components/ui/motion';
import { createSavedView } from '@/server/actions/views';
import { cn } from '@/lib/utils';
import { FOLDERS, folderLabel } from '@/lib/conversation-folder';

/**
 * `active` reads as "Inbox" because that is what it is — "Active" invited the
 * assumption that snoozed threads were still in it.
 */
const STATUSES = FOLDERS.map((key) => ({ key, label: folderLabel(key) }));
const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
const SORTS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'priority', label: 'Priority' },
] as const;

/** The split-inbox axis, in the words a person would use for it. */
export const KINDS = [
  { key: 'person', label: 'People' },
  { key: 'unknown', label: 'Unknown numbers' },
  { key: 'automated', label: 'Automated' },
  { key: 'otp', label: 'Verification codes' },
] as const;

export const kindLabel = (k: string) => KINDS.find((x) => x.key === k)?.label ?? k;

/** Read/write the inbox filter set through the URL, so views are shareable. */
export function useInboxFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo(
    () => ({
      status: searchParams.get('status') ?? 'active',
      assignee: searchParams.get('assignee') ?? undefined,
      teamId: searchParams.get('team') ?? undefined,
      kind: searchParams.get('kind') ?? undefined,
      bodyContains: searchParams.get('words')?.split(',').filter(Boolean) ?? [],
      inboxId: searchParams.get('inbox') ?? undefined,
      tagIds: searchParams.get('tags')?.split(',').filter(Boolean) ?? [],
      priorityIn: searchParams.get('priority')?.split(',').filter(Boolean) ?? [],
      slaBreached: searchParams.get('sla') === 'breached',
      unreadOnly: searchParams.get('unread') === '1',
      readNoReply: searchParams.get('seen') === '1',
      has: searchParams.get('has') ?? undefined,
      sort: searchParams.get('sort') ?? 'newest',
    }),
    [searchParams],
  );

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      // Filters belong to the list, so always navigate back to it.
      const base = pathname.startsWith('/inbox/') ? '/inbox' : pathname;
      const qs = next.toString();
      router.push(qs ? `${base}?${qs}` : base);
    },
    [pathname, router, searchParams],
  );

  const toggleInList = useCallback(
    (key: string, value: string) => {
      const current = (searchParams.get(key) ?? '').split(',').filter(Boolean);
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      setParam(key, next.join(','));
    },
    [searchParams, setParam],
  );

  const activeCount =
    (filters.status !== 'active' ? 1 : 0) +
    (filters.assignee ? 1 : 0) +
    (filters.teamId ? 1 : 0) +
    (filters.kind ? 1 : 0) +
    filters.bodyContains.length +
    (filters.inboxId ? 1 : 0) +
    filters.tagIds.length +
    filters.priorityIn.length +
    (filters.slaBreached ? 1 : 0) +
    (filters.unreadOnly ? 1 : 0) +
    (filters.readNoReply ? 1 : 0) +
    (filters.has ? 1 : 0);

  const clearAll = useCallback(() => router.push('/inbox'), [router]);

  return { filters, setParam, toggleInList, activeCount, clearAll };
}

function FilterChip({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      onClick={onClear}
      className="group flex shrink-0 items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:border-border-strong"
    >
      {label}
      <X className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground" />
    </motion.button>
  );
}

export function FilterBar({
  allTags,
  agents,
  inboxes,
  teams = [],
}: {
  allTags: { id: string; name: string; color: string }[];
  agents: { id: string; name: string | null; email: string }[];
  inboxes: { id: string; name: string }[];
  teams?: { id: string; name: string; color: string }[];
}) {
  const { filters, setParam, toggleInList, activeCount, clearAll } = useInboxFilters();
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [display, setDisplay] = useState<'sidebar' | 'section'>('sidebar');
  const [pending, start] = useTransition();
  const router = useRouter();
  const searchParams = useSearchParams();

  const tagById = useMemo(() => new Map(allTags.map((t) => [t.id, t])), [allTags]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  /** The current filter set, in the shape a folder stores. */
  const asViewFilters = useCallback(
    () => ({
      status: filters.status as never,
      assignee: filters.assignee,
      teamId: filters.teamId,
      kind: filters.kind as never,
      bodyContains: filters.bodyContains.length ? filters.bodyContains : undefined,
      inboxId: filters.inboxId,
      tagIds: filters.tagIds,
      priorityIn: filters.priorityIn as never,
      has: filters.has as never,
      slaBreached: filters.slaBreached || undefined,
      unreadOnly: filters.unreadOnly || undefined,
      readNoReply: filters.readNoReply || undefined,
      sort: filters.sort as never,
    }),
    [filters],
  );

  function saveView(display: 'sidebar' | 'section') {
    start(async () => {
      const res = await createSavedView({
        name: viewName,
        display,
        // asViewFilters carries everything main's inline object did, plus the
        // team / kind / bodyContains axes.
        filters: asViewFilters(),
      });
      if (res.ok) {
        toast.success(
          display === 'sidebar'
            ? `"${viewName}" added to the sidebar`
            : `"${viewName}" will show as a section in the inbox`,
        );
        setSaveOpen(false);
        setViewName('');
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="outline" className="gap-1">
            <ListFilter className="h-3.5 w-3.5" />
            Filter
            {activeCount > 0 && (
              <span className="tabular rounded bg-primary px-1 text-[10px] text-primary-foreground">
                {activeCount}
              </span>
            )}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Status
          </DropdownMenuLabel>
          {STATUSES.map((s) => (
            <DropdownMenuItem
              key={s.key}
              onClick={() => setParam('status', s.key === 'active' ? null : s.key)}
            >
              <span className="flex-1">{s.label}</span>
              {filters.status === s.key && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Priority
          </DropdownMenuLabel>
          {PRIORITIES.map((p) => (
            <DropdownMenuItem
              key={p}
              onClick={(e) => {
                e.preventDefault();
                toggleInList('priority', p);
              }}
              className="capitalize"
            >
              <span className="flex-1">{p}</span>
              {filters.priorityIn.includes(p) && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}

          {allTags.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                Tags
              </DropdownMenuLabel>
              <div className="max-h-40 overflow-y-auto">
                {allTags.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onClick={(e) => {
                      e.preventDefault();
                      toggleInList('tags', t.id);
                    }}
                  >
                    <span
                      className="mr-2 h-2 w-2 rounded-full"
                      style={{ backgroundColor: t.color }}
                    />
                    <span className="flex-1 truncate">{t.name}</span>
                    {filters.tagIds.includes(t.id) && <Check className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </div>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setParam('sla', filters.slaBreached ? null : 'breached')}>
            <span className="flex-1">Breaching SLA</span>
            {filters.slaBreached && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setParam('unread', filters.unreadOnly ? null : '1')}>
            <span className="flex-1">Unread only</span>
            {filters.unreadOnly && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
          {/* "They saw it and said nothing" — the state worth chasing. */}
          <DropdownMenuItem onClick={() => setParam('seen', filters.readNoReply ? null : '1')}>
            <span className="flex-1">Read, no reply</span>
            {filters.readNoReply && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>

          {teams.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                Team
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => setParam('team', filters.teamId === 'mine' ? null : 'mine')}
              >
                <span className="flex-1">My teams</span>
                {filters.teamId === 'mine' && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
              {teams.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onClick={() => setParam('team', filters.teamId === t.id ? null : t.id)}
                >
                  <span
                    className="mr-2 h-2 w-2 rounded-full"
                    style={{ backgroundColor: t.color }}
                  />
                  <span className="flex-1 truncate">{t.name}</span>
                  {filters.teamId === t.id && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => setParam('team', filters.teamId === 'none' ? null : 'none')}
              >
                <span className="flex-1 text-muted-foreground">No team</span>
                {filters.teamId === 'none' && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Who it&apos;s with
          </DropdownMenuLabel>
          {KINDS.map((k) => (
            <DropdownMenuItem
              key={k.key}
              onClick={() => setParam('kind', filters.kind === k.key ? null : k.key)}
            >
              <span className="flex-1">{k.label}</span>
              {filters.kind === k.key && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}

          {inboxes.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                Channel
              </DropdownMenuLabel>
              {inboxes.map((i) => (
                <DropdownMenuItem
                  key={i.id}
                  onClick={() => setParam('inbox', filters.inboxId === i.id ? null : i.id)}
                >
                  <span className="flex-1 truncate">{i.name}</span>
                  {filters.inboxId === i.id && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="ghost" className="gap-1 text-muted-foreground">
            <ArrowDownUp className="h-3.5 w-3.5" />
            {SORTS.find((s) => s.key === filters.sort)?.label ?? 'Newest first'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          {SORTS.map((s) => (
            <DropdownMenuItem
              key={s.key}
              onClick={() => setParam('sort', s.key === 'newest' ? null : s.key)}
            >
              <span className="flex-1">{s.label}</span>
              {filters.sort === s.key && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Active filter chips — click any to remove it. */}
      <AnimatePresence mode="popLayout">
        {filters.status !== 'active' && (
          <FilterChip
            key="status"
            label={STATUSES.find((s) => s.key === filters.status)?.label ?? filters.status}
            onClear={() => setParam('status', null)}
          />
        )}
        {filters.assignee && (
          <FilterChip
            key="assignee"
            label={
              filters.assignee === 'me'
                ? 'Mine'
                : filters.assignee === 'unassigned'
                  ? 'Unassigned'
                  : (agentById.get(filters.assignee)?.name ?? 'Assignee')
            }
            onClear={() => setParam('assignee', null)}
          />
        )}
        {filters.teamId && (
          <FilterChip
            key="team"
            label={
              filters.teamId === 'mine'
                ? 'My teams'
                : filters.teamId === 'none'
                  ? 'No team'
                  : (teamById.get(filters.teamId)?.name ?? 'Team')
            }
            onClear={() => setParam('team', null)}
          />
        )}
        {filters.kind && (
          <FilterChip
            key="kind"
            label={kindLabel(filters.kind)}
            onClear={() => setParam('kind', null)}
          />
        )}
        {filters.bodyContains.map((w) => (
          <FilterChip key={`w-${w}`} label={`"${w}"`} onClear={() => toggleInList('words', w)} />
        ))}
        {filters.priorityIn.map((p) => (
          <FilterChip key={`p-${p}`} label={p} onClear={() => toggleInList('priority', p)} />
        ))}
        {filters.tagIds.map((id) => (
          <FilterChip
            key={`t-${id}`}
            label={tagById.get(id)?.name ?? 'tag'}
            onClear={() => toggleInList('tags', id)}
          />
        ))}
        {filters.slaBreached && (
          <FilterChip key="sla" label="Breaching SLA" onClear={() => setParam('sla', null)} />
        )}
        {filters.has && (
          <FilterChip
            key="has"
            label={`has: ${filters.has}`}
            onClear={() => setParam('has', null)}
          />
        )}
        {filters.readNoReply && (
          <FilterChip
            key="seen"
            label="Read, no reply"
            onClear={() => setParam('seen', null)}
          />
        )}
        {filters.unreadOnly && (
          <FilterChip key="unread" label="Unread" onClear={() => setParam('unread', null)} />
        )}
      </AnimatePresence>

      {activeCount > 0 && (
        <>
          <button
            onClick={clearAll}
            className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear
          </button>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto gap-1 text-muted-foreground"
            onClick={() => {
              setViewName('');
              setDisplay('sidebar');
              setSaveOpen(true);
            }}
          >
            <Save className="h-3.5 w-3.5" />
            Save as folder
          </Button>
        </>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save as a folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-2.5 py-1">
            <Input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="e.g. Enterprise clients"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && viewName.trim()) saveView(display);
              }}
            />

            {/* Where it lives. A sidebar row is somewhere you go; a section is
                something you scroll past — the split-inbox shape. */}
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

            <p className="text-[11.5px] text-muted-foreground">
              Membership is computed, so it already contains everything that matches — and threads
              leave on their own when they stop. {searchParams.size} filter
              {searchParams.size === 1 ? '' : 's'} included.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => saveView(display)} loading={pending} disabled={!viewName.trim()}>
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
