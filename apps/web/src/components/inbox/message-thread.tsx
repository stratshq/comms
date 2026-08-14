'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  Clock,
  Loader2,
  AlertCircle,
  Paperclip,
  Lock,
  Mic,
  CloudOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { clockTime, dayLabel } from '@/lib/format';
import { markRead } from '@/server/actions/inbox';
import { MessageActions } from '@/components/inbox/message-actions';
import {
  Highlighted,
  ThreadFindBar,
  findOffsets,
  type FindMatch,
} from '@/components/inbox/thread-find';

type Attachment = {
  id: string;
  fileName: string | null;
  mimeType: string | null;
  status: string;
  isVoiceMemo?: boolean;
  /** Null when no browser-playable rendition could be produced (e.g. raw CAF). */
  playable?: boolean;
  transcript?: string | null;
  transcriptSource?: string | null;
};

export type ThreadMessage = {
  id: string;
  body: string | null;
  /** Null until the message has actually left the Mac — can't be reacted to yet. */
  providerMessageGuid?: string | null;
  authorType: 'contact' | 'agent' | 'system' | 'external';
  direction: 'inbound' | 'outbound';
  isPrivateNote: boolean;
  status: string;
  /** Set while a send is parked waiting for an unreachable Mac. */
  error?: string | null;
  authorName: string | null;
  /** For approved shared drafts: whose words these were ("drafted by X"). */
  draftedByName?: string | null;
  reactionType: string | null;
  /** For a tapback: the provider guid of the message it decorates. */
  associatedMessageGuid?: string | null;
  createdAt: Date | string;
  sentAt: Date | string | null;
  readAt: Date | string | null;
  deliveredAt: Date | string | null;
  attachments: Attachment[];
};

const REACTION_EMOJI: Record<string, string> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓',
};

function StatusTick({ message }: { message: ThreadMessage }) {
  if (message.isPrivateNote) return null;
  switch (message.status) {
    case 'queued':
      // A queued message carrying an error is parked waiting for the Mac —
      // say so, rather than letting it look like it's about to go out.
      return message.error ? (
        <span className="flex items-center gap-1 text-warning" title={message.error}>
          <CloudOff className="h-3 w-3" />
          waiting
        </span>
      ) : (
        <Clock className="h-3 w-3" />
      );
    case 'sending':
      return <Loader2 className="h-3 w-3 animate-spin" />;
    case 'failed':
      return <AlertCircle className="h-3 w-3 text-destructive" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-brand" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3" />;
    default:
      return <Check className="h-3 w-3" />;
  }
}

function AttachmentView({ att, onBubble }: { att: Attachment; onBubble: boolean }) {
  const isImage = att.mimeType?.startsWith('image/');

  if (att.status !== 'stored') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs',
          onBubble ? 'border-white/20 text-current opacity-80' : 'text-muted-foreground',
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {att.fileName ?? 'Attachment'} · downloading
      </div>
    );
  }

  // Voice memo: an inline player plus the transcript, which is the whole point
  // — a voice message you can't skim is the worst thing to get in a queue.
  if (att.isVoiceMemo) {
    return (
      <div className="space-y-1.5">
        {att.playable ? (
          <audio
            controls
            preload="metadata"
            src={`/api/attachments/${att.id}?rendition=playable`}
            className="h-9 w-full max-w-[280px]"
          />
        ) : (
          <a
            href={`/api/attachments/${att.id}`}
            target="_blank"
            rel="noreferrer"
            className={cn(
              'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors',
              onBubble ? 'border-white/20 hover:bg-white/10' : 'hover:bg-accent',
            )}
          >
            <Mic className="h-3.5 w-3.5 shrink-0" />
            Voice message — download to play
          </a>
        )}
        {att.transcript && (
          <p
            className={cn(
              'type-body flex gap-1.5 italic',
              onBubble ? 'opacity-90' : 'text-muted-foreground',
            )}
          >
            <Mic className="mt-[3px] h-3 w-3 shrink-0" />
            <span className="not-italic">{att.transcript}</span>
          </p>
        )}
      </div>
    );
  }

  if (isImage) {
    return (
      <a
        href={`/api/attachments/${att.id}`}
        target="_blank"
        rel="noreferrer"
        className="group/img block overflow-hidden rounded-xl"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/attachments/${att.id}`}
          alt={att.fileName ?? 'attachment'}
          className="max-h-72 max-w-full rounded-xl border transition-transform duration-300 ease-smooth group-hover/img:scale-[1.02]"
        />
      </a>
    );
  }

  return (
    <a
      href={`/api/attachments/${att.id}`}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors',
        onBubble ? 'border-white/20 hover:bg-white/10' : 'hover:bg-accent',
      )}
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{att.fileName ?? 'Download attachment'}</span>
    </a>
  );
}

/** Centred pill used for system events and reaction notices. */
function TimelineNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center py-1">
      <span className="type-caption rounded-full bg-secondary/70 px-2.5 py-1 text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

export function MessageThread({
  conversationId,
  messages,
  canReact = false,
  onReplyTo,
}: {
  conversationId: string;
  messages: ThreadMessage[];
  /** Private API available — tapbacks can actually be delivered. */
  canReact?: boolean;
  onReplyTo?: (m: { id: string; body: string | null; guid: string | null }) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement | null>());

  // ---- Find in conversation -------------------------------------------------
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  useEffect(() => {
    const open = () => setFindOpen(true);
    window.addEventListener('comms:thread-find', open);
    return () => window.removeEventListener('comms:thread-find', open);
  }, []);

  // Reset when the conversation changes — carrying a query and an index into a
  // different thread would scroll to an arbitrary message.
  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
  }, [conversationId]);

  const matches: FindMatch[] = useMemo(() => {
    const q = findQuery.trim();
    if (q.length < 2) return [];
    const out: FindMatch[] = [];
    for (const m of messages) {
      if (!m.body) continue;
      // System events and tapbacks render as centred pills with no ref and no
      // highlighting, so counting them produced hits that scrolled nowhere.
      if (m.authorType === 'system' || m.reactionType) continue;
      for (const offset of findOffsets(m.body, q)) out.push({ messageId: m.id, offset });
    }
    return out;
  }, [messages, findQuery]);

  /**
   * Tapbacks, grouped onto the message each one decorates.
   *
   * Only those whose target is resolved and present in the loaded thread; the
   * rest keep their own line so a reaction is never silently dropped.
   */
  const reactionsByTarget = useMemo(() => {
    const guids = new Set(
      messages.map((m) => m.providerMessageGuid).filter((g): g is string => Boolean(g)),
    );
    const byTarget = new Map<string, ThreadMessage[]>();
    for (const m of messages) {
      if (!m.reactionType || !m.associatedMessageGuid) continue;
      if (!guids.has(m.associatedMessageGuid)) continue;
      // A removal cancels the reaction rather than adding a second chip.
      const list = byTarget.get(m.associatedMessageGuid) ?? [];
      if (m.reactionType.startsWith('-')) {
        const base = m.reactionType.slice(1);
        byTarget.set(
          m.associatedMessageGuid,
          list.filter((r) => !(r.reactionType === base && r.direction === m.direction)),
        );
        continue;
      }
      list.push(m);
      byTarget.set(m.associatedMessageGuid, list);
    }
    return byTarget;
  }, [messages]);

  /** Tapbacks rendered on a bubble must not also render as their own row. */
  const attachedIds = useMemo(
    () => new Set(Array.from(reactionsByTarget.values()).flat().map((m) => m.id)),
    [reactionsByTarget],
  );

  // A shrinking result set must not leave the index pointing past the end.
  useEffect(() => setFindIndex(0), [findQuery]);
  const activeMatch = matches[Math.min(findIndex, Math.max(matches.length - 1, 0))] ?? null;

  useEffect(() => {
    if (!activeMatch) return;
    nodeRefs.current
      .get(activeMatch.messageId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatch]);

  function step(delta: 1 | -1) {
    if (matches.length === 0) return;
    setFindIndex((i) => (i + delta + matches.length) % matches.length);
  }

  useEffect(() => {
    // Don't fight the find bar for the scroll position.
    if (findOpen && findQuery) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, findOpen, findQuery]);

  useEffect(() => {
    void markRead(conversationId);
  }, [conversationId, messages.length]);

  let lastDay = '';

  /**
   * The last outbound message that the recipient actually opened.
   *
   * Apple gives us a real timestamp here, unlike the tracking pixels every
   * email client relies on — it is accurate, unblockable and not a trick. Only
   * the most recent one is annotated: iMessage shows one read line, and a
   * timestamp under every message you ever sent would be noise.
   */
  const readReceiptId = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.authorType === 'system' || m.reactionType) continue;
      // An inbound reply supersedes the receipt: once they answered, "they
      // read it" stops being the interesting fact.
      if (m.direction === 'inbound') return null;
      if (m.isPrivateNote) continue;
      if (m.readAt) return m.id;
      return null;
    }
    return null;
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadFindBar
        open={findOpen}
        query={findQuery}
        onQueryChange={setFindQuery}
        onClose={() => {
          setFindOpen(false);
          setFindQuery('');
        }}
        matchCount={matches.length}
        activeIndex={matches.length ? Math.min(findIndex, matches.length - 1) : 0}
        onStep={step}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5 md:py-6">
        <div className="mx-auto w-full max-w-[680px] space-y-1">
        {messages.map((m, i) => {
          // A tapback that found its target rides on that bubble instead of
          // taking a line of its own — a heart is a note about a message, and
          // reading "You reacted ❤️" underneath the thing you hearted is a
          // worse rendering of the same fact.
          const attached = m.providerMessageGuid ? reactionsByTarget.get(m.providerMessageGuid) : undefined;
          const stamp = m.sentAt ?? m.createdAt;
          const day = dayLabel(stamp);
          const showDay = day !== lastDay;
          if (showDay) lastDay = day;

          const dayDivider = showDay ? (
            <div key={`day-${m.id}`} className="flex items-center gap-3 py-4">
              <div className="divider-fade h-px flex-1" />
              <span className="type-caption font-medium text-muted-foreground">{day}</span>
              <div className="divider-fade h-px flex-1" />
            </div>
          ) : null;

          if (m.authorType === 'system') {
            return (
              <div key={m.id}>
                {dayDivider}
                <TimelineNote>{m.body}</TimelineNote>
              </div>
            );
          }

          if (m.reactionType) {
            if (attachedIds.has(m.id)) return null;
            const base = m.reactionType.replace('-', '');
            const removed = m.reactionType.startsWith('-');
            return (
              <div key={m.id}>
                {dayDivider}
                <TimelineNote>
                  {/* `||`, not `??` — an unnamed handle arrives as '' and would
                      render this line starting with a space. */}
                  {m.authorName || (m.direction === 'inbound' ? 'Contact' : 'You')}{' '}
                  {removed ? 'removed a' : 'reacted'} {REACTION_EMOJI[base] ?? '👍'}
                </TimelineNote>
              </div>
            );
          }

          const isOutbound = m.direction === 'outbound';
          const isNote = m.isPrivateNote;

          // Consecutive messages from the same side group together: tighter spacing
          // and a squared-off corner on the joining edge, like iMessage.
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const sameAsPrev =
            !showDay &&
            prev &&
            !prev.reactionType &&
            prev.authorType !== 'system' &&
            prev.direction === m.direction &&
            prev.isPrivateNote === m.isPrivateNote;
          const sameAsNext =
            next &&
            !next.reactionType &&
            next.authorType !== 'system' &&
            next.direction === m.direction &&
            next.isPrivateNote === m.isPrivateNote;

          return (
            <div
              key={m.id}
              ref={(el) => {
                nodeRefs.current.set(m.id, el);
              }}
            >
              {dayDivider}
              <div
                className={cn(
                  'group/msg flex animate-bubble-in flex-col',
                  isOutbound ? 'items-end' : 'items-start',
                  sameAsPrev ? 'mt-0.5' : 'mt-3',
                )}
              >
                {isOutbound && m.authorName && !isNote && !sameAsPrev && (
                  <span className="type-caption mb-1 px-1 font-medium text-muted-foreground">
                    {m.authorName}
                    {m.draftedByName && (
                      <span className="font-normal text-muted-foreground/70">
                        {' '}
                        · drafted by {m.draftedByName}
                      </span>
                    )}
                  </span>
                )}

                {/**
                 * Full width, with the side chosen by justification.
                 *
                 * This row used to be shrink-to-fit, which left the bubble's
                 * `max-w-[min(78%,46ch)]` resolving its percentage against a
                 * containing block whose width depended on the bubble itself.
                 * Narrow bubbles were fine; ones that actually reached the cap
                 * resolved against an indefinite width and landed on the wrong
                 * side of the thread. `justify-end` reads correctly in both
                 * directions — under `flex-row-reverse` the main axis is
                 * mirrored, so it packs left.
                 */}
                <div
                  className={cn(
                    'flex w-full items-center gap-1 justify-end',
                    isOutbound ? 'flex-row' : 'flex-row-reverse',
                  )}
                >
                  {onReplyTo && !isNote && (
                    <MessageActions
                      conversationId={conversationId}
                      messageId={m.id}
                      canReact={canReact && Boolean(m.providerMessageGuid)}
                      side={isOutbound ? 'right' : 'left'}
                      onReply={() =>
                        onReplyTo({
                          id: m.id,
                          body: m.body,
                          guid: m.providerMessageGuid ?? null,
                        })
                      }
                    />
                  )}
                  <div
                  className={cn(
                    'type-body max-w-[min(78%,46ch)] space-y-2 px-3.5 py-2 shadow-xs',
                    // Rounded 18px everywhere, squared on the grouped edge.
                    'rounded-[1.15rem]',
                    isOutbound
                      ? sameAsPrev && sameAsNext
                        ? 'rounded-br-md rounded-tr-md'
                        : sameAsPrev
                          ? 'rounded-tr-md'
                          : sameAsNext
                            ? 'rounded-br-md'
                            : ''
                      : sameAsPrev && sameAsNext
                        ? 'rounded-bl-md rounded-tl-md'
                        : sameAsPrev
                          ? 'rounded-tl-md'
                          : sameAsNext
                            ? 'rounded-bl-md'
                            : '',
                    isNote
                      ? 'border border-warning/35 bg-warning-muted text-foreground'
                      : isOutbound
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {isNote && (
                    <p className="type-micro flex items-center gap-1 text-warning">
                      <Lock className="h-2.5 w-2.5" />
                      Internal note
                    </p>
                  )}
                    {m.body && (
                      <p className="whitespace-pre-wrap break-words">
                        {findQuery.trim().length >= 2 ? (
                          <Highlighted
                            text={m.body}
                            query={findQuery.trim()}
                            activeOffset={
                              activeMatch?.messageId === m.id ? activeMatch.offset : undefined
                            }
                          />
                        ) : (
                          m.body
                        )}
                      </p>
                    )}
                    {m.attachments.map((a) => (
                      <AttachmentView key={a.id} att={a} onBubble={isOutbound && !isNote} />
                    ))}
                  </div>
                </div>

                {/* Tapbacks, sitting on the bubble they decorate. Overlapping
                    it the way Messages does, so it reads as a mark on the
                    message rather than a reply to it. */}
                {attached && attached.length > 0 && (
                  <div
                    className={cn(
                      '-mt-2 flex gap-0.5',
                      isOutbound ? 'mr-2 flex-row-reverse' : 'ml-2',
                    )}
                  >
                    {attached.map((r) => (
                      <span
                        key={r.id}
                        title={`${r.authorName || (r.direction === 'inbound' ? 'They' : 'You')} reacted`}
                        className="rounded-full border bg-surface px-1.5 py-0.5 text-[11px] leading-none shadow-xs"
                      >
                        {REACTION_EMOJI[r.reactionType!.replace('-', '')] ?? '👍'}
                      </span>
                    ))}
                  </div>
                )}

                {/* Timestamp only on the last message of a group — cuts visual noise a lot. */}
                {!sameAsNext && (
                  <div
                    className={cn(
                      'type-caption mt-1 flex items-center gap-1 px-1 text-muted-foreground',
                      isOutbound && 'flex-row-reverse',
                    )}
                  >
                    <span className="tabular">{clockTime(stamp)}</span>
                    {isOutbound && <StatusTick message={m} />}
                  </div>
                )}

                {m.id === readReceiptId && (
                  <div className="type-caption mt-0.5 flex items-center gap-1 px-1 text-muted-foreground">
                    <CheckCheck className="h-3 w-3 text-brand" />
                    <span>
                      Read <span className="tabular">{clockTime(m.readAt)}</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
