'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Search,
  Check,
  Loader2,
  Inbox as InboxIcon,
  X,
  Pencil,
  Eye,
  BellOff,
  AlarmClockCheck,
  Boxes,
  ChevronDown,
  Crosshair,
  Folder as FolderIcon,
  KeyRound,
  Copy,
  Pin,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { AnimatePresence, motion } from '@/components/ui/motion';
// Subpath import, not the barrel: the barrel pulls BullMQ and ioredis, which
// cannot be bundled for the browser.
import { extractOtpCode } from '@comms/core/correspondent';
import type { FolderQuery } from '@comms/db/query';
import { bulkUpdateConversations } from '@/server/actions/inbox';
import { dissolveBundle, restoreBundle } from '@/server/actions/bundles';
import { setPinned, togglePin } from '@/server/actions/pins';
import { matchesQuery } from '@/lib/folder-query';
import { undoToast } from '@/lib/undo';
import { FilterBar } from '@/components/inbox/filter-bar';
import { setVisibleConversationIds } from '@/lib/inbox-nav';
import { conversationName, nameForInitials } from '@/lib/naming';
import { matchesFolder } from '@/lib/conversation-folder';
import { cn, initials } from '@/lib/utils';
import { listTime, relativeTime } from '@/lib/format';
import type { ConversationListItem } from '@/server/queries';

/** Priority reads as a coloured spine on the row edge, not another dot in the row. */
const PRIORITY_SPINE: Record<string, string> = {
  urgent: 'bg-destructive',
  high: 'bg-warning',
  normal: 'bg-transparent',
  low: 'bg-transparent',
};

/**
 * A folder's stored filters, as the list evaluates them client-side.
 *
 * Every membership key in `ViewFilters` must appear here AND in
 * `SECTION_KEYS` below. An unhandled key is not "no match", it is "no
 * restriction" — a folder filtered on something the predicate skips silently
 * claims the entire inbox and renders it under one header.
 */
export type SectionFilters = {
  kind?: string;
  tagIds?: string[];
  inboxId?: string;
  assignee?: string;
  priorityIn?: string[];
  unreadOnly?: boolean;
  readNoReply?: boolean;
  status?: string;
  has?: string;
  bodyContains?: string[];
  slaBreached?: boolean;
  pinnedOnly?: boolean;
  /** The AND/OR condition set, evaluated by `matchesQuery`. */
  query?: FolderQuery;
  /** Ordering, not membership — present in stored filters, ignored here. */
  sort?: string;
  /** Bookkeeping for the Workspace switches — not a filter. */
  splitKey?: string;
};

/**
 * Keys the section predicate actually implements. Anything stored outside
 * this set makes the folder un-renderable as a section, and it is skipped
 * rather than shown wrong — see `folderSections`.
 */
const SECTION_KEYS = new Set([
  'kind',
  'tagIds',
  'inboxId',
  'assignee',
  'priorityIn',
  'unreadOnly',
  'readNoReply',
  'status',
  'has',
  'bodyContains',
  'slaBreached',
  'pinnedOnly',
  'query',
  'sort',
  'splitKey',
]);

/**
 * Does one conversation belong in a folder?
 *
 * The single client-side implementation, used both for the sections inside
 * the list and for a sidebar folder opened via `?view=`. One function because
 * two would drift, and a folder that counts differently from how it renders
 * is the failure this whole layer is arranged to avoid — see the SQL twin in
 * `buildConversationWhere`.
 */
function matchesViewFilters(
  f: SectionFilters,
  c: ConversationListItem,
  ctx: { currentUserId: string; draftIds: Set<string>; pinnedIds: Set<string> },
): boolean {
  if (f.kind && c.kind !== f.kind) return false;
  if (f.inboxId && c.inboxId !== f.inboxId) return false;
  if (f.assignee === 'me' && c.assigneeId !== ctx.currentUserId) return false;
  else if (f.assignee === 'unassigned' && c.assigneeId) return false;
  // A folder can name a specific teammate, not just me/unassigned.
  else if (f.assignee && f.assignee !== 'me' && f.assignee !== 'unassigned') {
    if (c.assigneeId !== f.assignee) return false;
  }
  if (f.priorityIn?.length && !f.priorityIn.includes(c.priority)) return false;
  if (f.unreadOnly && c.unreadCount === 0) return false;
  if (f.readNoReply && !c.readNoReply) return false;
  if (f.slaBreached && !c.slaBreachedAt) return false;
  // Folders default to the inbox; a stored status narrows further.
  if (f.status && !matchesFolder(c.status, f.status, ctx.draftIds.has(c.id))) return false;
  if (f.has) {
    const present =
      f.has === 'photo'
        ? c.hasPhoto
        : f.has === 'voice'
          ? c.hasVoice
          : f.has === 'link'
            ? c.hasLink
            : c.hasAttachment;
    if (!present) return false;
  }
  // Same rule as the SQL: latest message + title.
  if (f.bodyContains?.length) {
    const hay = `${c.lastMessagePreview ?? ''} ${c.title ?? ''}`.toLowerCase();
    if (!f.bodyContains.some((w) => hay.includes(w.toLowerCase()))) return false;
  }
  if (f.tagIds?.length) {
    const ids = new Set(c.tags?.map((t) => t.tag.id) ?? []);
    if (!f.tagIds.every((id) => ids.has(id))) return false;
  }
  if (f.pinnedOnly && !ctx.pinnedIds.has(c.id)) return false;
  // The custom condition set. Same evaluator the badge count uses on the
  // server side — see `@/lib/folder-query`.
  if (
    f.query &&
    !matchesQuery(
      f.query,
      { ...c, pinned: ctx.pinnedIds.has(c.id), tagIds: c.tags?.map((t) => t.tag.id) ?? [] },
      { currentUserId: ctx.currentUserId },
    )
  ) {
    return false;
  }
  return true;
}

/** True when a folder's filters are all ones the predicate above implements. */
function isRenderableFolder(f: SectionFilters): boolean {
  return !Object.entries(f).some(
    ([k, v]) => !SECTION_KEYS.has(k) && v !== undefined && v !== null,
  );
}

export function ConversationListPane({
  conversations,
  currentUserId,
  showChannels = false,
  allTags = [],
  agents = [],
  inboxes = [],
  folders = [],
  draftConversationIds = [],
  pinnedConversationIds = [],
  pinnedFirst = true,
}: {
  conversations: ConversationListItem[];
  currentUserId: string;
  currentUserName: string;
  /** Conversations this user pinned. Personal — see `togglePin`. */
  pinnedConversationIds?: string[];
  /** Their preference for whether pins float to the top. */
  pinnedFirst?: boolean;
  /** Conversations where the signed-in user has unsent text. */
  draftConversationIds?: string[];
  /** When multiple numbers are connected, show which inbox each conversation belongs to. */
  showChannels?: boolean;
  allTags?: { id: string; name: string; color: string }[];
  agents?: { id: string; name: string | null; email: string }[];
  inboxes?: { id: string; name: string }[];
  /**
   * Every folder visible to this user, sections and sidebar rows alike.
   * Sections group the list; sidebar rows are looked up here by `?view=`,
   * which is how a folder whose rule has no URL spelling still opens.
   */
  folders?: { id: string; name: string; display: 'sidebar' | 'section'; filters: SectionFilters }[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftIds = useMemo(() => new Set(draftConversationIds), [draftConversationIds]);

  // Pins are held locally so a click reorders the list on the same frame the
  // pointer goes down; the server action reconciles behind it. Re-seeded when
  // the server sends a new set, which is what makes another tab's pin show up.
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(
    () => new Set(pinnedConversationIds),
  );
  useEffect(() => {
    setPinnedIds(new Set(pinnedConversationIds));
  }, [pinnedConversationIds.join(',')]);

  function pin(id: string, name: string) {
    const wasPinned = pinnedIds.has(id);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (wasPinned) next.delete(id);
      else next.add(id);
      return next;
    });
    void togglePin(id).then((res) => {
      if (!res.ok) {
        // Put the row back where it was rather than leaving the list showing
        // an order the server disagrees with.
        setPinnedIds((prev) => {
          const next = new Set(prev);
          if (wasPinned) next.add(id);
          else next.delete(id);
          return next;
        });
        toast.error(res.error);
        return;
      }
      undoToast(wasPinned ? `Unpinned ${name}` : `Pinned ${name}`, async () => {
        setPinnedIds((prev) => {
          const next = new Set(prev);
          if (wasPinned) next.add(id);
          else next.delete(id);
          return next;
        });
        return setPinned(id, wasPinned);
      });
    });
  }

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, startBulk] = useTransition();

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bulk(patch: { status?: 'open' | 'pending' | 'closed' }) {
    const ids = Array.from(selected);
    // Capture what each row was BEFORE the change, so Undo can put every
    // conversation back to its own previous status, not a blanket one.
    const prevStatuses = new Map(
      conversations.filter((c) => selected.has(c.id)).map((c) => [c.id, c.status]),
    );
    startBulk(async () => {
      const res = await bulkUpdateConversations(ids, patch);
      if (!res.ok) toast.error(res.error);
      else {
        undoToast(`Updated ${ids.length} conversation${ids.length === 1 ? '' : 's'}`, async () => {
          const byStatus = new Map<string, string[]>();
          for (const [id, status] of prevStatuses) {
            // Bulk updates can't produce 'snoozed'; a formerly-snoozed row
            // reopens instead, which is also what unsnoozing would do.
            const restorable = status === 'open' || status === 'pending' || status === 'closed' ? status : 'open';
            byStatus.set(restorable, [...(byStatus.get(restorable) ?? []), id]);
          }
          for (const [status, group] of byStatus) {
            const r = await bulkUpdateConversations(group, {
              status: status as 'open' | 'pending' | 'closed',
            });
            if (!r.ok) return r;
          }
          return { ok: true as const };
        }, { onUndone: () => router.refresh() });
        setSelected(new Set());
        router.refresh();
      }
    });
  }

  const assignee = searchParams.get('assignee');
  const statusFilter = searchParams.get('status') ?? 'active';
  const inboxFilter = searchParams.get('inbox');
  const kindFilter = searchParams.get('kind');
  const wordsFilter = searchParams.get('words')?.split(',').filter(Boolean) ?? [];
  const tagFilter = searchParams.get('tags')?.split(',').filter(Boolean) ?? [];
  const priorityFilter = searchParams.get('priority')?.split(',').filter(Boolean) ?? [];
  const slaFilter = searchParams.get('sla') === 'breached';
  const unreadFilter = searchParams.get('unread') === '1';
  const seenFilter = searchParams.get('seen') === '1';
  const hasFilter = searchParams.get('has');
  const sort = searchParams.get('sort') ?? 'newest';
  const activeId = pathname.startsWith('/inbox/') ? pathname.split('/inbox/')[1] : null;

  /**
   * A folder opened from the sidebar.
   *
   * Most folders round-trip through ordinary filter params, so the filter bar
   * shows what you're looking at. A rule with and/or in it has no spelling in
   * a query string, so those folders link to `?view=<id>` and are applied
   * here instead — by the same predicate the sections use, against the same
   * stored filters the badge was counted from.
   */
  const viewId = searchParams.get('view');
  const activeView = viewId ? folders.find((f) => f.id === viewId) : undefined;

  // Filtering and sorting run client-side against the loaded working set so
  // every filter change is instant (no server round-trip). Saved-view badge
  // counts come from SQL, which is what keeps them accurate beyond this window.
  const filtered = useMemo(() => {
    const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const rows = conversations.filter((c) => {
      if (activeView) {
        // Unrenderable here means unevaluable, and an unevaluable folder shows
        // nothing rather than everything.
        if (!isRenderableFolder(activeView.filters)) return false;
        if (!matchesViewFilters(activeView.filters, c, { currentUserId, draftIds, pinnedIds })) {
          return false;
        }
      }
      if (inboxFilter && c.inboxId !== inboxFilter) return false;
      if (kindFilter && c.kind !== kindFilter) return false;
      // Same rule as the SQL in buildConversationWhere — preview + title, so
      // a folder's badge count and its visible rows can never disagree.
      if (wordsFilter.length) {
        const hay = `${c.lastMessagePreview ?? ''} ${c.title ?? ''}`.toLowerCase();
        if (!wordsFilter.some((w) => hay.includes(w.toLowerCase()))) return false;
      }
      if (assignee === 'me' && c.assigneeId !== currentUserId) return false;
      if (assignee === 'unassigned' && c.assigneeId) return false;
      if (assignee && assignee !== 'me' && assignee !== 'unassigned' && c.assigneeId !== assignee)
        return false;
      // Shared with the server filter so the list and the sidebar counts can
      // never disagree about what is in the inbox.
      if (!matchesFolder(c.status, statusFilter, draftIds.has(c.id))) return false;
      if (priorityFilter.length && !priorityFilter.includes(c.priority)) return false;
      if (slaFilter && !c.slaBreachedAt) return false;
      if (unreadFilter && c.unreadCount === 0) return false;
      if (seenFilter && !c.readNoReply) return false;
      if (hasFilter) {
        const present =
          hasFilter === 'photo'
            ? c.hasPhoto
            : hasFilter === 'voice'
              ? c.hasVoice
              : hasFilter === 'link'
                ? c.hasLink
                : c.hasAttachment;
        if (!present) return false;
      }
      // AND semantics: every selected tag must be present.
      if (tagFilter.length) {
        const ids = new Set(c.tags?.map((t) => t.tag.id) ?? []);
        if (!tagFilter.every((id) => ids.has(id))) return false;
      }
      if (query) {
        // Search the address too, so typing a phone number finds the thread.
        const hay = `${c.contact?.displayName ?? ''} ${c.title ?? ''} ${
          c.contact?.identities?.map((i) => `${i.value} ${i.rawValue ?? ''}`).join(' ') ?? ''
        } ${c.lastMessagePreview ?? ''}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });

    const time = (c: (typeof rows)[number]) =>
      new Date(c.lastMessageAt ?? c.createdAt).getTime();
    // In the snoozed folder the question is "what comes back next", so wake
    // order beats recency — same as every mail client's snoozed list.
    if (statusFilter === 'snoozed') {
      rows.sort(
        (a, b) =>
          new Date(a.snoozedUntil ?? 0).getTime() - new Date(b.snoozedUntil ?? 0).getTime(),
      );
    } else if (sort === 'oldest') rows.sort((a, b) => time(a) - time(b));
    else if (sort === 'priority')
      rows.sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          time(b) - time(a),
      );
    else rows.sort((a, b) => time(b) - time(a));

    // Pins float, they don't freeze: a pinned row keeps its place relative to
    // the other pinned rows, so a pinned thread that just got a reply still
    // rises above one that went quiet. A stable partition, not a re-sort.
    if (pinnedFirst && pinnedIds.size > 0) {
      const pinnedRows = rows.filter((c) => pinnedIds.has(c.id));
      if (pinnedRows.length > 0 && pinnedRows.length < rows.length) {
        return [...pinnedRows, ...rows.filter((c) => !pinnedIds.has(c.id))];
      }
    }

    return rows;
  }, [
    conversations,
    draftIds,
    pinnedFirst,
    pinnedIds,
    activeView,
    assignee,
    statusFilter,
    inboxFilter,
    kindFilter,
    wordsFilter.join(','),
    query,
    currentUserId,
    // Arrays are rebuilt each render; compare by value to avoid a render loop.
    tagFilter.join(','),
    priorityFilter.join(','),
    slaFilter,
    unreadFilter,
    seenFilter,
    hasFilter,
    sort,
  ]);

  // ---- Bundles: AI-grouped sections in the inbox ---------------------------
  // Grouping is a display choice, so it persists like one. Sections only
  // exist in the Inbox tab — a bundle header inside "Closed" answers nothing.
  const [grouping, setGrouping] = useState(true);
  const [collapsedBundles, setCollapsedBundles] = useState<Set<string>>(new Set());
  useEffect(() => {
    setGrouping(window.localStorage.getItem('comms:bundle-group') !== '0');
  }, []);

  // Standing inside one folder, the other folders' headers are noise — the
  // list is already the answer to "what's in here".
  const canGroup = statusFilter === 'active' && !query && !activeView;

  /**
   * Folder sections — the split inbox.
   *
   * Evaluated against the already-filtered rows so a section can never show
   * something the current filter excludes, and each row lands in the FIRST
   * folder that claims it: a thread appearing under two headers reads as a
   * duplicate, not as two memberships.
   */
  const folderSections = useMemo(() => {
    if (!canGroup || folders.length === 0) return [];
    const claimed = new Set<string>();
    const out: { id: string; name: string; rows: typeof filtered }[] = [];

    for (const folder of folders) {
      if (folder.display !== 'section') continue;
      const f = folder.filters ?? {};

      // Fail closed. A key the predicate cannot evaluate would otherwise be
      // treated as no restriction, and the folder would swallow the inbox.
      if (!isRenderableFolder(f)) continue;

      const rows = filtered.filter((c) => {
        if (claimed.has(c.id)) return false;
        return matchesViewFilters(f, c, { currentUserId, draftIds, pinnedIds });
      });
      if (rows.length === 0) continue;
      for (const r of rows) claimed.add(r.id);
      out.push({ id: folder.id, name: folder.name, rows });
    }
    return out;
  }, [filtered, folders, canGroup, currentUserId, draftIds, pinnedIds]);

  const folderClaimedIds = useMemo(
    () => new Set(folderSections.flatMap((s) => s.rows.map((r) => r.id))),
    [folderSections],
  );

  const bundleGroups = useMemo(() => {
    if (!canGroup || !grouping) return [];
    const groups = new Map<string, { id: string; name: string; rows: typeof filtered }>();
    for (const c of filtered) {
      // An explicit folder outranks an AI guess about the same thread.
      if (folderClaimedIds.has(c.id)) continue;
      if (!c.bundle) continue;
      const g = groups.get(c.bundle.id) ?? { id: c.bundle.id, name: c.bundle.name, rows: [] };
      g.rows.push(c);
      groups.set(c.bundle.id, g);
    }
    // A "group" of one is just a row with extra chrome.
    return Array.from(groups.values()).filter((g) => g.rows.length >= 2);
  }, [filtered, canGroup, grouping, folderClaimedIds]);

  const bundledIds = useMemo(
    () => new Set(bundleGroups.flatMap((g) => g.rows.map((r) => r.id))),
    [bundleGroups],
  );
  const ungrouped = useMemo(
    () =>
      folderSections.length || bundleGroups.length
        ? filtered.filter((c) => !bundledIds.has(c.id) && !folderClaimedIds.has(c.id))
        : filtered,
    [filtered, bundleGroups, bundledIds, folderSections, folderClaimedIds],
  );

  function toggleGrouping() {
    setGrouping((g) => {
      window.localStorage.setItem('comms:bundle-group', g ? '0' : '1');
      return !g;
    });
  }

  function dissolve(bundleId: string, name: string) {
    void dissolveBundle(bundleId).then((res) => {
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      undoToast(`Dissolved “${name}” — it won't be recreated`, () =>
        restoreBundle(res.name, res.conversationIds),
      { onUndone: () => router.refresh() });
      router.refresh();
    });
  }

  /** Toggle a tag in the URL filter — used by the clickable tag chips. */
  function toggleTagFilter(tagId: string) {
    const current = (searchParams.get('tags') ?? '').split(',').filter(Boolean);
    const next = current.includes(tagId)
      ? current.filter((t) => t !== tagId)
      : [...current, tagId];
    const params = new URLSearchParams(searchParams.toString());
    if (next.length) params.set('tags', next.join(','));
    else params.delete('tags');
    const qs = params.toString();
    router.push(qs ? `/inbox?${qs}` : '/inbox');
  }

  // Publish the visible ordering for the global j/k keyboard navigation.
  // Mirrors the DISPLAY order — bundle sections first, then the rest — and
  // skips rows folded inside a collapsed bundle, so j/k never jumps somewhere
  // invisible.
  useEffect(() => {
    const order =
      folderSections.length || bundleGroups.length
        ? [
            ...folderSections.flatMap((f) =>
              collapsedBundles.has(f.id) ? [] : f.rows.map((r) => r.id),
            ),
            ...bundleGroups.flatMap((g) =>
              collapsedBundles.has(g.id) ? [] : g.rows.map((r) => r.id),
            ),
            ...ungrouped.map((c) => c.id),
          ]
        : filtered.map((c) => c.id);
    setVisibleConversationIds(order);
  }, [filtered, folderSections, bundleGroups, ungrouped, collapsedBundles]);

  /** Selection mode: once anything is picked, every row offers its checkbox. */
  const selecting = selected.size > 0;

  /**
   * Display sections, in order: folders you defined, then bundles the AI
   * guessed, then everything else. Explicit beats inferred.
   */
  type Section = {
    key: string;
    /** Present for AI bundles — they carry a dissolve affordance. */
    bundle: { id: string; name: string } | null;
    /** Present for folders — a plain header. */
    folder: { id: string; name: string } | null;
    rows: typeof filtered;
  };

  const sections = useMemo<Section[]>(() => {
    if (folderSections.length === 0 && bundleGroups.length === 0) {
      return [{ key: 'all', bundle: null, folder: null, rows: filtered }];
    }
    const list: Section[] = [
      ...folderSections.map((f) => ({
        key: `folder-${f.id}`,
        bundle: null,
        folder: { id: f.id, name: f.name },
        rows: f.rows,
      })),
      ...bundleGroups.map((g) => ({
        key: g.id,
        bundle: { id: g.id, name: g.name },
        folder: null,
        rows: g.rows,
      })),
    ];
    if (ungrouped.length) list.push({ key: 'rest', bundle: null, folder: null, rows: ungrouped });
    return list;
  }, [folderSections, bundleGroups, ungrouped, filtered]);

  // Drafts earns a tab only when you have one. An always-present empty folder
  // is chrome; one that appears because you left something unsent is a prompt.
  const tabs = [
    { label: 'Inbox', href: '/inbox', key: 'active' },
    { label: 'Mine', href: '/inbox?assignee=me', key: 'mine' },
    ...(draftIds.size > 0
      ? [{ label: 'Drafts', href: '/inbox?status=drafts', key: 'drafts' }]
      : []),
    { label: 'Snoozed', href: '/inbox?status=snoozed', key: 'snoozed' },
    { label: 'Closed', href: '/inbox?status=closed', key: 'closed' },
  ];

  // A truly empty Active queue (no filters, no search) is an achievement.
  const inboxZero =
    filtered.length === 0 && !query && !assignee && statusFilter === 'active' && !inboxFilter;

  return (
    // Mobile is master/detail: the list owns the screen at /inbox and hides
    // once a conversation is open; md+ shows both panes side by side.
    <div
      className={cn(
        'w-full shrink-0 flex-col border-r bg-surface md:flex md:w-[380px]',
        activeId ? 'hidden' : 'flex',
      )}
    >
      <div className="pane-x space-y-2.5 pb-3 pt-3">
        <div className="group relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground/70 transition-colors group-focus-within:text-brand" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="type-item h-10 rounded-xl pl-9 pr-8"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Sliding segmented control — quick presets over the filter bar. */}
        <div className="flex items-center gap-1">
        <div className="flex flex-1 items-center gap-0.5 rounded-xl bg-secondary/60 p-[3px]">
          {tabs.map((t) => {
            const isActive =
              (t.key === 'active' && !assignee && statusFilter === 'active') ||
              (t.key === 'mine' && assignee === 'me') ||
              (t.key === 'drafts' && statusFilter === 'drafts') ||
              (t.key === 'snoozed' && statusFilter === 'snoozed') ||
              (t.key === 'closed' && statusFilter === 'closed');
            return (
              <Link
                key={t.key}
                href={t.href}
                className={cn(
                  'type-caption relative flex-1 rounded-lg px-2 py-1.5 text-center font-medium transition-colors duration-150',
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="list-tab"
                    className="absolute inset-0 rounded-lg bg-surface shadow-xs"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative">{t.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Focus & Reply: work this exact queue one screen at a time. */}
        <Link
          href={`/focus?queue=${assignee === 'me' ? 'mine' : statusFilter === 'drafts' ? 'drafts' : 'inbox'}`}
          title="Focus & Reply — work the stack one conversation at a time"
          aria-label="Focus and reply"
          className="rounded-lg p-1.5 text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-foreground active:scale-95"
        >
          <Crosshair className="h-[15px] w-[15px]" />
        </Link>
        {canGroup && (
          <button
            type="button"
            onClick={toggleGrouping}
            title={grouping ? 'Show as a flat list' : 'Group similar conversations'}
            aria-label="Toggle bundle grouping"
            aria-pressed={grouping}
            className={cn(
              'rounded-lg p-1.5 transition-all duration-150 hover:bg-accent active:scale-95',
              grouping && bundleGroups.length > 0
                ? 'text-brand'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Boxes className="h-[15px] w-[15px]" />
          </button>
        )}
        </div>
      </div>

      <FilterBar allTags={allTags} agents={agents} inboxes={inboxes} />

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            className="overflow-hidden border-y bg-brand-muted/60"
          >
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="font-medium text-brand">{selected.size} selected</span>
              <div className="ml-auto flex items-center gap-0.5">
                {bulkPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={bulkPending}
                  onClick={() => bulk({ status: 'closed' })}
                >
                  Close
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={bulkPending}
                  onClick={() => bulk({ status: 'open' })}
                >
                  Reopen
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pane-x min-h-0 flex-1 overflow-y-auto pb-2">
        {inboxZero ? (
          <div className="flex animate-slide-up flex-col items-center justify-center gap-3.5 px-6 py-20 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
              <Check className="h-6 w-6" strokeWidth={2.5} />
            </div>
            <div>
              <p className="type-title">Inbox Zero</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Every conversation handled. Nicely done — new messages will appear here the moment
                they arrive.
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-secondary text-muted-foreground">
              <InboxIcon className="h-5 w-5" />
            </div>
            <div>
              {/* An empty Snoozed folder means something different from an
                  empty inbox, and saying "new conversations appear here" would
                  be a lie in both Snoozed and Closed. */}
              <p className="text-sm font-medium">
                {query
                  ? 'No matches'
                  : statusFilter === 'snoozed'
                    ? 'Nothing snoozed'
                    : statusFilter === 'closed'
                      ? 'Nothing closed yet'
                      : statusFilter === 'drafts'
                        ? 'No unsent drafts'
                        : 'Nothing here yet'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {query
                  ? 'Try a different search term.'
                  : statusFilter === 'snoozed'
                    ? 'Snoozed conversations wait here and return to your inbox at the time you picked.'
                    : statusFilter === 'closed'
                      ? 'Conversations you close land here. They reopen automatically if someone writes back.'
                      : statusFilter === 'drafts'
                        ? 'Replies you start but do not send are kept here until you finish them.'
                        : 'New conversations will appear here automatically.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-px">
            {sections.map((sec) => (
              <div key={sec.key}>
                {sec.folder && (
                  <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-3 first:pt-1">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedBundles((prev) => {
                          const next = new Set(prev);
                          if (next.has(sec.folder!.id)) next.delete(sec.folder!.id);
                          else next.add(sec.folder!.id);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      aria-expanded={!collapsedBundles.has(sec.folder.id)}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150',
                          collapsedBundles.has(sec.folder.id) && '-rotate-90',
                        )}
                      />
                      <FolderIcon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                      <span className="type-micro truncate text-muted-foreground">
                        {sec.folder.name}
                      </span>
                      <span className="tabular type-caption shrink-0 text-muted-foreground/60">
                        {sec.rows.length}
                      </span>
                    </button>
                  </div>
                )}
                {sec.bundle && (
                  <div className="group/bundle flex items-center gap-1.5 px-2 pb-0.5 pt-3 first:pt-1">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedBundles((prev) => {
                          const next = new Set(prev);
                          if (next.has(sec.bundle!.id)) next.delete(sec.bundle!.id);
                          else next.add(sec.bundle!.id);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      aria-expanded={!collapsedBundles.has(sec.bundle.id)}
                    >
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150',
                          collapsedBundles.has(sec.bundle.id) && '-rotate-90',
                        )}
                      />
                      <Boxes className="h-3 w-3 shrink-0 text-brand" />
                      <span className="type-micro truncate text-muted-foreground">
                        {sec.bundle.name}
                      </span>
                      <span className="tabular type-caption shrink-0 text-muted-foreground/60">
                        {sec.rows.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => dissolve(sec.bundle!.id, sec.bundle!.name)}
                      title="Dissolve this bundle"
                      aria-label={`Dissolve bundle ${sec.bundle.name}`}
                      className="rounded p-0.5 text-muted-foreground/50 opacity-0 transition-all hover:text-foreground group-hover/bundle:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                {sec.key === 'rest' && (
                  <p className="type-micro px-2 pb-0.5 pt-3 text-muted-foreground/60">Other</p>
                )}
                {!collapsedBundles.has(sec.bundle?.id ?? sec.folder?.id ?? '') &&
                  sec.rows.map((c) => {
              const active = c.id === activeId;
              const isSelected = selected.has(c.id);
              const nameInput = {
                contactName: c.contact?.displayName,
                contactAddress: c.contact?.identities?.[0]?.value,
                // The GUID carries the number even when no contact was linked.
                chatGuid: c.providerChatGuid,
                title: c.title,
                isGroup: c.isGroup,
              };
              const name = conversationName(nameInput);
              const unread = c.unreadCount > 0;
              const nudgeMeta = (c.metadata as { nudge?: { dismissedAt?: string } } | null)?.nudge;
              const hasNudge = Boolean(nudgeMeta && !nudgeMeta.dismissedAt);
              const muted = Boolean(c.mutedAt);
              const isPinned = pinnedIds.has(c.id);
              // Only for threads the classifier called a code — running the
              // extractor over every preview would find false positives in
              // order numbers and addresses.
              const otpCode = c.kind === 'otp' ? extractOtpCode(c.lastMessagePreview) : null;
              const hasMeta =
                unread ||
                hasNudge ||
                c.readNoReply ||
                Boolean(c.slaBreachedAt) ||
                Boolean(c.nextResponseDueAt && c.status !== 'closed') ||
                (c.status !== 'open' && c.status !== 'closed') ||
                (showChannels && Boolean(c.inbox)) ||
                (c.tags?.length ?? 0) > 0;

              return (
                <Link
                  key={c.id}
                  href={`/inbox/${c.id}`}
                  className={cn(
                    'group relative flex gap-3 rounded-xl px-3 py-3 transition-colors duration-150',
                    active ? 'bg-brand-muted' : isSelected ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  {/* Priority spine — urgent and high only. A marker that
                      appears on every row marks nothing. */}
                  {(c.priority === 'urgent' || c.priority === 'high') && (
                    <span
                      className={cn(
                        'absolute inset-y-3 left-0 w-[3px] rounded-full',
                        PRIORITY_SPINE[c.priority],
                      )}
                    />
                  )}

                  <div className="relative h-10 w-10 shrink-0">
                    <Avatar
                      className={cn(
                        'h-10 w-10 ring-1 ring-border transition-opacity duration-150',
                        // Only fade the face away once selecting is actually
                        // happening. Blanking every avatar on casual hover made
                        // scanning the list flicker.
                        selecting && 'group-hover:opacity-0',
                        isSelected && 'opacity-0',
                      )}
                    >
                      {c.contact?.avatarUrl && <AvatarImage src={c.contact.avatarUrl} alt={name} />}
                      <AvatarFallback className="type-caption bg-secondary font-semibold text-muted-foreground">
                        {initials(nameForInitials(nameInput))}
                      </AvatarFallback>
                    </Avatar>

                    {/* Checkbox occupies the avatar's slot on hover — no layout shift. */}
                    <button
                      onClick={(e) => toggleSelect(c.id, e)}
                      className={cn(
                        'absolute inset-0 grid place-items-center rounded-full border transition-all duration-150',
                        isSelected
                          ? 'border-brand bg-brand text-brand-foreground opacity-100'
                          : cn(
                              'border-border-strong bg-surface text-transparent opacity-0 hover:border-brand hover:text-muted-foreground',
                              // Reachable on hover of the avatar itself, and
                              // shown across the list once selection begins.
                              selecting ? 'group-hover:opacity-100' : 'hover:opacity-100',
                            ),
                      )}
                      aria-label={isSelected ? 'Deselect' : 'Select'}
                    >
                      <Check className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2.5">
                      <p
                        className={cn(
                          'type-title truncate',
                          !unread && 'font-medium text-foreground/90',
                        )}
                      >
                        {name}
                      </p>
                      <span className="tabular type-caption flex shrink-0 items-center gap-1 text-muted-foreground/80">
                        {muted && (
                          <BellOff
                            className="h-3 w-3 text-muted-foreground/60"
                            aria-label="Muted"
                          />
                        )}
                        {/* Visible once pinned, otherwise only on hover: an
                            affordance on every row at all times is noise, but
                            a pin you can't see isn't a pin. */}
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            pin(c.id, name);
                          }}
                          title={isPinned ? 'Unpin' : 'Pin to top'}
                          aria-label={isPinned ? `Unpin ${name}` : `Pin ${name} to top`}
                          aria-pressed={isPinned}
                          className={cn(
                            'rounded p-0.5 transition-all duration-150 hover:text-foreground',
                            isPinned
                              ? 'text-brand'
                              : 'text-muted-foreground/50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                          )}
                        >
                          <Pin className={cn('h-3 w-3', isPinned && 'fill-current')} />
                        </button>
                        {listTime(c.lastMessageAt)}
                      </span>
                    </div>

                    {/* Two lines, not one. A single truncated line tells you
                        almost nothing about a text message, and the second line
                        is what lets you triage without opening the thread. */}
                    {/* An unsent draft outranks everything — it is the thing
                        you have to deal with. Then the code chip: a
                        verification code is read once and never replied to,
                        so copying it here means never opening the thread. */}
                    {draftIds.has(c.id) ? (
                      <p className="type-body mt-1 flex items-center gap-1.5 text-muted-foreground">
                        <Pencil className="h-3 w-3 shrink-0 text-warning" />
                        <span className="truncate italic">Draft</span>
                      </p>
                    ) : otpCode ? (
                      <div className="mt-1 flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void navigator.clipboard
                              .writeText(otpCode)
                              .then(() => toast.success(`Copied ${otpCode}`))
                              .catch(() => toast.error('Could not copy'));
                          }}
                          title="Copy code"
                          className="tabular flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-muted px-1.5 py-0.5 font-mono text-[12px] font-semibold text-brand transition-colors hover:bg-brand-muted/70"
                        >
                          <KeyRound className="h-3 w-3" />
                          {otpCode}
                          <Copy className="h-2.5 w-2.5 opacity-60" />
                        </button>
                      </div>
                    ) : (
                      <p
                        className={cn(
                          'type-body mt-1 line-clamp-2',
                          unread ? 'text-foreground/75' : 'text-muted-foreground',
                        )}
                      >
                        {c.lastMessagePreview || 'No messages yet'}
                      </p>
                    )}

                    {hasMeta && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {unread && (
                          <Badge variant="brand" size="sm" className="tabular">
                            {c.unreadCount}
                          </Badge>
                        )}
                        {/* Apple tells us they opened it. Saying so is the
                            whole reason this data is worth having. */}
                        {c.readNoReply && !unread && (
                          <Badge variant="outline" size="sm" className="gap-1">
                            <Eye className="h-3 w-3" />
                            Seen
                          </Badge>
                        )}
                        {/* A promise you made and haven't kept outranks most
                            other row facts — it's the one only you can fix. */}
                        {hasNudge && (
                          <Badge variant="soft-warning" size="sm" className="gap-1">
                            <AlarmClockCheck className="h-3 w-3" />
                            Nudge
                          </Badge>
                        )}
                        {c.slaBreachedAt ? (
                          <Badge variant="soft-danger" size="sm">
                            Overdue
                          </Badge>
                        ) : c.nextResponseDueAt && c.status !== 'closed' ? (
                          <Badge variant="soft-warning" size="sm">
                            due {relativeTime(c.nextResponseDueAt)}
                          </Badge>
                        ) : null}
                        {/* In the snoozed folder the useful fact is when it
                            comes back, not that it is snoozed — you can see
                            that from the folder you are standing in. */}
                        {c.status === 'snoozed' && c.snoozedUntil ? (
                          <Badge variant="outline" size="sm">
                            wakes {relativeTime(c.snoozedUntil)}
                          </Badge>
                        ) : (
                          c.status !== 'open' &&
                          c.status !== 'closed' && (
                            <Badge variant="outline" size="sm" className="capitalize">
                              {c.status}
                            </Badge>
                          )
                        )}
                        {showChannels && c.inbox && (
                          <span
                            className="type-caption inline-flex items-center gap-1 rounded-md px-1.5 py-px font-medium"
                            style={{ backgroundColor: `${c.inbox.color}18`, color: c.inbox.color }}
                            title={`Number: ${c.inbox.name}`}
                          >
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: c.inbox.color }}
                            />
                            {c.inbox.name}
                          </span>
                        )}
                        {c.tags?.slice(0, 2).map((t) => (
                          // Clicking a tag filters the list by it — the whole
                          // point of tagging, and previously a dead end.
                          <button
                            key={t.tag.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleTagFilter(t.tag.id);
                            }}
                            title={`Filter by ${t.tag.name}`}
                            className="type-caption inline-flex items-center rounded-md px-1.5 py-px font-medium transition-opacity hover:opacity-75"
                            style={{ backgroundColor: `${t.tag.color}18`, color: t.tag.color }}
                          >
                            {t.tag.name}
                          </button>
                        ))}
                        {(c.tags?.length ?? 0) > 2 && (
                          <span className="type-caption text-muted-foreground/70">
                            +{c.tags!.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
              );
                  })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
