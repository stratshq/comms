'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Sparkles, AlertTriangle, Clock, Star, ChevronRight } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateConversation, toggleTag } from '@/server/actions/inbox';
import { undoToast } from '@/lib/undo';
import { relativeTime } from '@/lib/format';
import { PersonCard, type PersonCardProps } from '@/components/inbox/person-card';
import { cn, initials } from '@/lib/utils';

const UNASSIGNED = '__unassigned__';

const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'bg-success-muted text-success',
  negative: 'bg-destructive-muted text-destructive',
  neutral: 'bg-secondary text-muted-foreground',
};

function Section({
  label,
  children,
  icon: Icon,
}: {
  label: string;
  children: React.ReactNode;
  icon?: React.ElementType;
}) {
  return (
    <section className="border-t px-4 py-3.5 first:border-t-0">
      <p className="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/70">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      {children}
    </section>
  );
}

/**
 * A section you can fold away. Used for the ticket controls, which are
 * administration rather than context — a personal user never opens them, and a
 * support user opens them once per conversation, not every time they look.
 */
function CollapsibleSection({
  label,
  children,
  defaultOpen = true,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t px-4 py-3.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="type-micro flex w-full items-center gap-1.5 text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-90')}
        />
        {label}
      </button>
      {open && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <div className="w-[58%]">{children}</div>
    </div>
  );
}

export function TicketPanel({
  conversation,
  agents,
  allTags,
  ai,
  sla,
  person,
}: {
  conversation: {
    id: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    contactName: string;
    contactIdentities: string[];
    inboxName: string;
    tagIds: string[];
  };
  /** Who you are talking to — rendered above the workflow controls. */
  person?: PersonCardProps | null;
  agents: { id: string; name: string | null; email: string }[];
  allTags: { id: string; name: string; color: string }[];
  ai?: { summary?: string; topic?: string; sentiment?: string } | null;
  sla?: {
    nextResponseDueAt: Date | string | null;
    slaBreachedAt: Date | string | null;
    csatScore: number | null;
  } | null;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const pending = false; // controls stay interactive — updates are optimistic

  // Optimistic local copies of every editable field: the control flips
  // instantly, the server action runs in the background, failures revert.
  // Server props re-sync after router.refresh (SSE-driven or explicit).
  const [status, setStatus] = useState(conversation.status);
  const [priority, setPriority] = useState(conversation.priority);
  const [assigneeId, setAssigneeId] = useState(conversation.assigneeId);
  const [tagIds, setTagIds] = useState<string[]>(conversation.tagIds);
  useEffect(() => setStatus(conversation.status), [conversation.status]);
  useEffect(() => setPriority(conversation.priority), [conversation.priority]);
  useEffect(() => setAssigneeId(conversation.assigneeId), [conversation.assigneeId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTagIds(conversation.tagIds), [conversation.tagIds.join(',')]);

  function optimistic(
    apply: () => void,
    revert: () => void,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    /** When present, success shows the standard undo toast running `inverse`. */
    undo?: { label: string; inverse: () => Promise<{ ok: boolean; error?: string }> },
  ) {
    apply();
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        revert();
        toast.error(res.error ?? 'Something went wrong');
      } else {
        if (undo) {
          undoToast(undo.label, undo.inverse, {
            onUndone: () => {
              revert();
              router.refresh();
            },
          });
        }
        router.refresh();
      }
    });
  }

  const showSla = Boolean(sla?.slaBreachedAt || sla?.nextResponseDueAt || sla?.csatScore != null);

  return (
    // Width, border and scrolling are owned by the DetailsPane that hosts this.
    <div className="flex flex-col">
      {person ? (
        <PersonCard {...person} />
      ) : (
        <div className="flex flex-col items-center gap-2.5 px-4 py-5 text-center">
          <Avatar className="h-14 w-14 ring-1 ring-border">
            <AvatarFallback className="bg-brand-muted text-base font-semibold text-brand">
              {initials(conversation.contactName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="type-title truncate">{conversation.contactName}</p>
            <p className="type-body truncate text-muted-foreground">
              {conversation.contactIdentities[0] ?? 'No contact info'}
            </p>
          </div>
        </div>
      )}

      {ai?.summary && (
        <Section label="AI summary" icon={Sparkles}>
          <div className="rounded-lg border border-brand-border/50 bg-brand-muted/60 p-2.5">
            <p className="text-[12.5px] leading-relaxed">{ai.summary}</p>
            {(ai.topic || ai.sentiment) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ai.topic && (
                  <span className="rounded-md bg-surface/70 px-1.5 py-px text-[11px] font-medium">
                    {ai.topic}
                  </span>
                )}
                {ai.sentiment && (
                  <span
                    className={cn(
                      'rounded-md px-1.5 py-px text-[11px] font-medium capitalize',
                      SENTIMENT_STYLE[ai.sentiment] ?? 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {ai.sentiment}
                  </span>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      <CollapsibleSection label="Ticket" defaultOpen={false}>
        <div className="space-y-2.5">
          <Field label="Assignee">
            <Select
              value={assigneeId ?? UNASSIGNED}
              onValueChange={(v) => {
                const prev = assigneeId;
                const next = v === UNASSIGNED ? null : v;
                optimistic(
                  () => setAssigneeId(next),
                  () => setAssigneeId(prev),
                  () => updateConversation({ id: conversation.id, assigneeId: next }),
                  {
                    label: next ? 'Assignee changed' : 'Unassigned',
                    inverse: () => updateConversation({ id: conversation.id, assigneeId: prev }),
                  },
                );
              }}
              disabled={pending}
            >
              <SelectTrigger className="h-8 text-[12.5px]">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ?? a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Status">
            <Select
              value={status}
              onValueChange={(v) => {
                const prev = status;
                optimistic(
                  () => setStatus(v),
                  () => setStatus(prev),
                  () =>
                    updateConversation({
                      id: conversation.id,
                      status: v as 'open' | 'pending' | 'snoozed' | 'closed',
                    }),
                  {
                    label: `Marked ${v}`,
                    inverse: () =>
                      updateConversation({
                        id: conversation.id,
                        status: prev as 'open' | 'pending' | 'snoozed' | 'closed',
                      }),
                  },
                );
              }}
              disabled={pending}
            >
              <SelectTrigger className="h-8 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="snoozed">Snoozed</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Priority">
            <Select
              value={priority}
              onValueChange={(v) => {
                const prev = priority;
                optimistic(
                  () => setPriority(v),
                  () => setPriority(prev),
                  () =>
                    updateConversation({
                      id: conversation.id,
                      priority: v as 'low' | 'normal' | 'high' | 'urgent',
                    }),
                  {
                    label: `Priority set to ${v}`,
                    inverse: () =>
                      updateConversation({
                        id: conversation.id,
                        priority: prev as 'low' | 'normal' | 'high' | 'urgent',
                      }),
                  },
                );
              }}
              disabled={pending}
            >
              <SelectTrigger className="h-8 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </CollapsibleSection>

      <Section label="Tags">
        {allTags.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No tags yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((t) => {
              const active = tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  disabled={pending}
                  onClick={() => {
                    const prev = tagIds;
                    optimistic(
                      () =>
                        setTagIds(
                          active ? prev.filter((id) => id !== t.id) : [...prev, t.id],
                        ),
                      () => setTagIds(prev),
                      () => toggleTag(conversation.id, t.id),
                    );
                  }}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-all duration-150 active:scale-95',
                    active
                      ? 'border-transparent'
                      : 'border-border text-muted-foreground hover:border-border-strong hover:bg-accent',
                  )}
                  style={active ? { backgroundColor: `${t.color}20`, color: t.color } : undefined}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {showSla && (
        <Section label="Service level">
          <div className="space-y-2">
            {sla!.slaBreachedAt ? (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive-muted px-2.5 py-2 text-[12px] font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Response overdue
              </div>
            ) : sla!.nextResponseDueAt ? (
              <div className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-2.5 py-2 text-[12px] text-muted-foreground">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                Due <span className="text-foreground">{relativeTime(sla!.nextResponseDueAt)}</span>
              </div>
            ) : null}
            {sla!.csatScore != null && (
              <div className="flex items-center gap-1.5 px-0.5 text-[12px] text-muted-foreground">
                <span>Rating</span>
                <span className="ml-auto flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star
                      key={n}
                      className={cn(
                        'h-3 w-3',
                        n <= sla!.csatScore!
                          ? 'fill-warning text-warning'
                          : 'text-muted-foreground/30',
                      )}
                    />
                  ))}
                </span>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section label="Channel">
        <p className="text-[12.5px]">{conversation.inboxName}</p>
      </Section>
    </div>
  );
}
