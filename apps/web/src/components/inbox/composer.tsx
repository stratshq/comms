'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  Send,
  Zap,
  StickyNote,
  CornerDownLeft,
  Clock,
  CornerUpLeft,
  X,
  Users,
  Share2,
  PenLine,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AnimatePresence, motion } from '@/components/ui/motion';
import { AiAssist } from '@/components/inbox/ai-assist';
import {
  MacroPicker,
  useMacroPickerState,
  type MacroOption,
} from '@/components/inbox/macro-picker';
import { applyMacro } from '@/server/actions/macros';
import { completeMessageAction } from '@/server/actions/ai';
import { sendTypingIndicator } from '@/server/actions/imessage';
import { clearDraft, saveDraft, shareMyDraft, unshareDraft } from '@/server/actions/drafts';
import { SEND_LATER_PRESETS } from '@/lib/snooze';
import { CustomTimePicker } from '@/components/inbox/time-picker';
import { OfferTimes } from '@/components/inbox/offer-times';
import type { BusinessHours } from '@/lib/availability';
import { cn } from '@/lib/utils';
import { useKeymap } from '@/components/app/keymap-provider';
import { useCurrentUser } from '@/components/app/realtime-provider';
import { firstNames, useTypingPeers } from '@/lib/use-peers';

export function Composer({
  conversationId,
  macros,
  aiEnabled,
  aiDraft,
  initialDraft,
  replyTo,
  onCancelReply,
  onSubmit,
  businessHours,
  signaturePreview,
  viaInbox,
}: {
  conversationId: string;
  macros: MacroOption[];
  aiEnabled: boolean;
  /** Pre-computed suggestion shown as ghost text; Tab accepts it. */
  aiDraft?: string | null;
  /** The caller's unsent draft for this conversation, restored on mount. */
  initialDraft?: { body: string; isPrivateNote: boolean; shared?: boolean } | null;
  /** The message this reply is threaded to, if any. */
  replyTo?: { id: string; body: string | null; guid: string | null } | null;
  onCancelReply?: () => void;
  /**
   * Owns the actual send (optimistic append + server action + undo toast).
   * Returns false on failure so the composer can restore the draft.
   */
  onSubmit: (body: string, isNote: boolean, scheduledFor?: Date) => Promise<boolean>;
  /** Workspace business hours — enables the "Offer times" picker. */
  businessHours?: BusinessHours | null;
  /** The signature that will be appended at send time, when one applies. */
  signaturePreview?: string | null;
  /** Which number this reply goes out from — shown when several are connected. */
  viaInbox?: { name: string; color: string } | null;
}) {
  const { enterSends } = useKeymap();
  const me = useCurrentUser();
  // Read at the composer, not just in the header strip: a warning you have
  // stopped noticing is not a warning, and the cost of a duplicate reply to a
  // customer is paid by them, not by us.
  const typingPeers = useTypingPeers(conversationId);
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [isNote, setIsNote] = useState(initialDraft?.isPrivateNote ?? false);
  const [focused, setFocused] = useState(false);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTypingPing = useRef(0);
  /** Set once the user has ACKNOWLEDGED a collision, so we ask only once. */
  const confirmedCollision = useRef(false);
  /** Always the current render's submit — see the collision toast. */
  const submitRef = useRef<(scheduledFor?: Date) => void>(() => {});
  /** Inline completion shown after the caret; Tab accepts it. */
  const [completion, setCompletion] = useState('');
  const ghostRef = useRef<HTMLDivElement>(null);
  const picker = useMacroPickerState(macros, body);

  // Shared-draft state for the caller's own draft. Editing a shared draft
  // keeps it shared — the row updates live for whoever is reviewing it.
  const [shared, setShared] = useState(Boolean(initialDraft?.shared));
  const [sharePending, startShare] = useTransition();

  // The global `r` shortcut focuses the composer from anywhere in the thread.
  useEffect(() => {
    const focus = () => ref.current?.focus();
    window.addEventListener('comms:focus-composer', focus);
    return () => window.removeEventListener('comms:focus-composer', focus);
  }, []);

  // "Edit in composer" on a teammate's shared draft loads its text here.
  useEffect(() => {
    const load = (e: Event) => {
      const text = (e as CustomEvent<{ body?: string }>).detail?.body;
      if (!text) return;
      // Never destroy what's already typed — append below it instead.
      setBody((b) => (b.trim() ? `${b.trimEnd()}\n${text}` : text));
      setIsNote(false);
      ref.current?.focus();
    };
    window.addEventListener('comms:load-draft', load);
    return () => window.removeEventListener('comms:load-draft', load);
  }, []);

  // Broadcast a throttled "typing" presence ping so other agents see collisions,
  // and — when the inbox enables it — show the customer a real iMessage typing
  // bubble. Stops after a pause or on send so it never sticks on.
  useEffect(() => {
    if (!body.trim() || isNote) return;
    const now = Date.now();
    if (now - lastTypingPing.current < 2000) return;
    lastTypingPing.current = now;

    fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, state: 'typing' }),
    }).catch(() => {});

    void sendTypingIndicator({ conversationId, isTyping: true });
  }, [body, conversationId, isNote]);

  // Clear the customer-facing bubble ~4s after they stop typing.
  useEffect(() => {
    if (isNote) return;
    const t = setTimeout(() => {
      if (lastTypingPing.current > 0) {
        lastTypingPing.current = 0;
        void sendTypingIndicator({ conversationId, isTyping: false });
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [body, conversationId, isNote]);

  // Swapping conversations swaps the draft. Without this the component is
  // reused across routes and the previous thread's text stays in the box.
  const loadedFor = useRef(conversationId);
  useEffect(() => {
    if (loadedFor.current === conversationId) return;
    loadedFor.current = conversationId;
    setBody(initialDraft?.body ?? '');
    setIsNote(initialDraft?.isPrivateNote ?? false);
    setShared(Boolean(initialDraft?.shared));
    // Acknowledging a collision in one conversation must not disarm the
    // warning in the next one.
    confirmedCollision.current = false;
  }, [conversationId, initialDraft]);

  /**
   * Persist the draft, debounced.
   *
   * Deliberately does NOT run on first render: mounting a conversation whose
   * draft is empty would otherwise fire a delete for a draft that may have been
   * written on another device a second ago.
   */
  const savedBody = useRef(initialDraft?.body ?? '');
  const savedIsNote = useRef(initialDraft?.isPrivateNote ?? false);
  useEffect(() => {
    if (body === savedBody.current && isNote === savedIsNote.current) return;
    const id = conversationId;
    const t = setTimeout(() => {
      savedBody.current = body;
      savedIsNote.current = isNote;
      void saveDraft({ conversationId: id, body, isPrivateNote: isNote }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [body, isNote, conversationId]);

  // A tab close skips the debounce entirely, which is exactly when losing the
  // draft would hurt most. keepalive lets the request outlive the page.
  useEffect(() => {
    const flush = () => {
      if (body === savedBody.current && isNote === savedIsNote.current) return;
      navigator.sendBeacon?.(
        '/api/drafts',
        new Blob([JSON.stringify({ conversationId, body, isPrivateNote: isNote })], {
          type: 'application/json',
        }),
      );
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [body, isNote, conversationId]);

  /**
   * Smart Compose: ask for a continuation once typing pauses.
   *
   * Gated hard on purpose. It costs a model call per pause, and a suggestion
   * that arrives while someone is still typing is noise — so it only fires
   * after 700ms of stillness, only for a real reply (never a note), only past
   * a few words, and never when the caret is somewhere other than the end,
   * because a completion appended to the middle of a sentence is nonsense.
   */
  useEffect(() => {
    setCompletion('');
    if (!aiEnabled || isNote) return;
    const text = body;
    if (text.trim().length < 8) return;
    if (/[.!?]\s*$/.test(text)) return;

    let cancelled = false;
    const t = setTimeout(() => {
      const el = ref.current;
      if (el && el.selectionStart !== text.length) return;
      void completeMessageAction({ conversationId, prefix: text })
        .then((res) => {
          // Only apply if the user hasn't typed on: a stale completion would
          // attach to text it was never computed from.
          if (cancelled) return;
          if (ref.current?.value !== text) return;
          setCompletion(res.completion);
        })
        .catch(() => {});
    }, 700);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [body, isNote, aiEnabled, conversationId]);

  // The ghost layer sits behind the textarea and must scroll with it.
  function syncGhostScroll() {
    if (ghostRef.current && ref.current) ghostRef.current.scrollTop = ref.current.scrollTop;
  }

  // Grow the textarea with its content instead of scrolling inside a fixed box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // Measured against the GHOST as well: a completion that wraps onto a new
    // line would otherwise be clipped out of sight while Tab still accepted it.
    const needed = Math.max(el.scrollHeight, ghostRef.current?.scrollHeight ?? 0);
    el.style.height = `${Math.min(needed, 180)}px`;
    // A ghost that mounts while the field is already scrolled must start at the
    // same offset; the scroll event alone never fires in that case.
    syncGhostScroll();
  }, [body, completion]);

  function submit(scheduledFor?: Date) {
    const trimmed = body.trim();
    if (!trimmed) return;

    // Confirm rather than block. The person at the keyboard may know exactly
    // what they are doing — but they should have to say so, once.
    if (typingPeers.length > 0 && !isNote && !confirmedCollision.current) {
      toast.warning(`${firstNames(typingPeers)} is also replying`, {
        description: 'Send anyway?',
        action: {
          label: 'Send',
          // Through a ref, NOT the captured `submit`. Sonner freezes the
          // handler at raise time, so calling the closure directly sent the
          // body as it was when the toast appeared and discarded everything
          // typed during the eight seconds it was on screen.
          onClick: () => {
            confirmedCollision.current = true;
            submitRef.current(scheduledFor);
          },
        },
        duration: 8000,
      });
      return;
    }
    confirmedCollision.current = false;
    // Optimistic: clear the field immediately — the shell shows the bubble.
    setBody('');
    savedBody.current = '';
    start(async () => {
      const ok = await onSubmit(trimmed, isNote, scheduledFor);
      if (ok) {
        void clearDraft(conversationId).catch(() => {});
      } else {
        // Restore what they wrote, and re-persist it: a failed send is exactly
        // when the draft matters.
        setBody(trimmed);
        void saveDraft({ conversationId, body: trimmed, isPrivateNote: isNote }).catch(() => {});
      }
    });
  }

  // Rebound every render so the collision toast, which captured its handler
  // once, always reaches the current body.
  submitRef.current = submit;

  /**
   * Share (or unshare) the current draft with the team. The draft is flushed
   * to the server first so what teammates review is what's on the screen.
   */
  function toggleShare() {
    const trimmed = body.trim();
    if (!trimmed && !shared) return;
    startShare(async () => {
      if (shared) {
        if (!me?.id) return;
        // The composer only ever unshares its own draft.
        const res = await unshareDraft(conversationId, me.id).catch(() => ({ ok: false as const, error: 'Failed' }));
        if (res.ok) {
          setShared(false);
          toast.success('Draft is private again');
        } else {
          toast.error(res.error ?? 'Could not unshare');
        }
        return;
      }
      await saveDraft({ conversationId, body, isPrivateNote: false });
      savedBody.current = body;
      const res = await shareMyDraft(conversationId);
      if (res.ok) {
        setShared(true);
        toast.success('Draft shared — anyone on the team can review and send it');
      } else {
        toast.error(res.error ?? 'Could not share the draft');
      }
    });
  }

  /** Insert a macro: render its variables server-side and run its actions. */
  function pickMacro(m: MacroOption) {
    start(async () => {
      const res = await applyMacro({ macroId: m.id, conversationId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBody((b) => {
        // Slash-invoked macros replace the "/query"; button-invoked ones append.
        const base = /^\/[\w-]*$/.test(b) ? '' : b;
        return base ? `${base}\n${res.body}` : res.body;
      });
      if (res.appliedActions.length > 0) {
        toast.success(`Macro applied — ${res.appliedActions.join(', ')}`);
      }
      ref.current?.focus();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // While the slash picker is open it owns the arrows, Enter and Tab.
    if (picker.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        picker.setActiveIndex(Math.min(picker.activeIndex + 1, picker.filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        picker.setActiveIndex(Math.max(picker.activeIndex - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = picker.filtered[picker.activeIndex];
        if (chosen) pickMacro(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setBody('');
        return;
      }
    }

    // Tab accepts an inline completion first — it is the more immediate of the
    // two suggestions, and it only exists when the field is NOT empty, so the
    // two can never both apply.
    if (e.key === 'Tab' && !e.shiftKey && completion) {
      e.preventDefault();
      setBody((b) => b + completion);
      setCompletion('');
      return;
    }
    if (e.key === 'Escape' && completion) {
      e.preventDefault();
      setCompletion('');
      return;
    }

    // Tab accepts the pre-computed AI draft when the field is empty.
    if (e.key === 'Tab' && !e.shiftKey && aiDraft && !body.trim()) {
      e.preventDefault();
      setBody(aiDraft);
      return;
    }

    if (e.key === 'Enter') {
      // ⌘↵ always sends. Whether a bare ↵ sends or inserts a newline is the
      // user's call — texting people usually want it to send, writing longer
      // replies usually don't.
      const withModifier = e.metaKey || e.ctrlKey;
      if (withModifier || (enterSends && !e.shiftKey)) {
        e.preventDefault();
        submit();
      }
    }
  }

  const canSend = Boolean(body.trim()) && !pending;

  const collision = typingPeers.length > 0 && !isNote;

  return (
    <div className="mx-auto w-full max-w-[680px] px-3 pb-3 pt-1">
      <AnimatePresence>
        {collision && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            role="status"
            className="type-caption mb-1.5 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-muted px-2.5 py-1.5 text-warning"
          >
            <Users className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              {firstNames(typingPeers)} {typingPeers.length > 1 ? 'are' : 'is'} replying to this
              conversation
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      {picker.open && (
        <MacroPicker
          macros={macros}
          query={picker.query}
          onPick={pickMacro}
          onDismiss={() => undefined}
          activeIndex={picker.activeIndex}
          setActiveIndex={picker.setActiveIndex}
        />
      )}
      {/* One bordered surface containing toolbar + field + send, so the composer
          reads as a single object rather than three stacked strips. */}
      <div
        className={cn(
          'rounded-xl border bg-surface shadow-sm transition-all duration-200 ease-smooth',
          focused && !isNote && 'border-brand/50 ring-[3px] ring-brand/12',
          isNote && 'border-warning/45 bg-warning-muted/40',
          focused && isNote && 'ring-[3px] ring-warning/15',
        )}
      >
        {/* Reply-to banner: shows what this message threads onto. */}
        <AnimatePresence>
          {replyTo && !isNote && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              className="overflow-hidden"
            >
              <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border-l-2 border-primary bg-secondary/60 px-2.5 py-1.5">
                <CornerUpLeft className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="line-clamp-1 flex-1 text-[11.5px] text-muted-foreground">
                  {replyTo.body || 'Attachment'}
                </span>
                <button
                  type="button"
                  onClick={onCancelReply}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Cancel reply"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between gap-2 px-2 pt-2">
          {/* Segmented reply/note switch — clearer than a bare toggle. */}
          <div className="flex items-center gap-0.5 rounded-lg bg-secondary/70 p-0.5">
            <button
              type="button"
              onClick={() => setIsNote(false)}
              className={cn(
                'relative rounded-[0.4rem] px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150',
                !isNote ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {!isNote && (
                <motion.span
                  layoutId="composer-mode"
                  className="absolute inset-0 rounded-[0.4rem] bg-surface shadow-xs"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <span className="relative">Reply</span>
            </button>
            <button
              type="button"
              onClick={() => setIsNote(true)}
              className={cn(
                'relative flex items-center gap-1 rounded-[0.4rem] px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150',
                isNote ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {isNote && (
                <motion.span
                  layoutId="composer-mode"
                  className="absolute inset-0 rounded-[0.4rem] bg-surface shadow-xs"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <span className="relative flex items-center gap-1">
                <StickyNote className="h-3 w-3" />
                Note
              </span>
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            {/* Share draft: hand what you've written to the team for review. */}
            {!isNote && (body.trim() || shared) && (
              <Button
                variant="ghost"
                size="xs"
                onClick={toggleShare}
                disabled={sharePending}
                className={cn('gap-1.5', shared && 'text-brand')}
                title={shared ? 'Shared with the team — click to unshare' : 'Share draft for review'}
              >
                <Share2 className="h-3.5 w-3.5" />
                {shared ? 'Shared' : 'Share'}
              </Button>
            )}
            {businessHours && !isNote && (
              <OfferTimes
                hours={businessHours}
                onInsert={(text) => {
                  setBody((b) => (b.trim() ? `${b.trimEnd()}\n${text}` : text));
                  ref.current?.focus();
                }}
              />
            )}
            {aiEnabled && <AiAssist conversationId={conversationId} onDraft={setBody} />}
            {macros.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="xs" className="gap-1.5">
                    <Zap className="h-3.5 w-3.5" />
                    Macros
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-1">
                  <p className="px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                    Tip: type <kbd className="rounded border bg-secondary px-1">/</kbd> in the
                    composer to search macros without leaving the keyboard.
                  </p>
                  <div className="max-h-72 overflow-y-auto">
                    {macros.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => pickMacro(m)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent"
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="text-[13px] font-medium">{m.name}</span>
                          {m.shortcut && (
                            <span className="rounded bg-secondary px-1 font-mono text-[10px] text-muted-foreground">
                              /{m.shortcut}
                            </span>
                          )}
                          {m.hasActions && (
                            <span className="ml-auto rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">
                              + actions
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                          {m.body}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>

        <div className="flex items-end gap-2 p-2">
          <div className="relative min-w-0 flex-1">
            {/* Mirrors the textarea exactly and sits behind it: the typed text
                is rendered invisibly so the completion lands in the right
                place regardless of wrapping. Any typography change here must
                be made on both or the ghost drifts out of alignment. */}
            {completion && (
              <div
                ref={ghostRef}
                aria-hidden
                className="pointer-events-none absolute left-0 right-0 top-0 max-h-[180px] overflow-hidden whitespace-pre-wrap break-words px-1.5 py-1.5 text-[13.5px] leading-[inherit] md:text-[13.5px]"
              >
                <span className="invisible">{body}</span>
                <span className="text-muted-foreground/50">{completion}</span>
              </div>
            )}
          <Textarea
            ref={ref}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={syncGhostScroll}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={
              isNote
                ? 'Write an internal note — the customer never sees this…'
                : aiDraft
                  ? 'Type a message…  ⇥ to accept the suggested reply'
                  : 'Type a message…  /  for macros'
            }
            className="relative max-h-[180px] min-h-[38px] w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-[13.5px] shadow-none focus-visible:ring-0 md:text-[13.5px]"
            rows={1}
          />
          </div>
          <AnimatePresence mode="popLayout">
            {canSend || pending ? (
              <motion.div
                key="send"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="flex items-center gap-1"
              >
                {!isNote && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Send later"
                        title="Send later"
                      >
                        <Clock className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                        Send later…
                      </DropdownMenuLabel>
                      {SEND_LATER_PRESETS.map((p) => {
                        const when = p.until();
                        return (
                          <DropdownMenuItem key={p.key} onClick={() => submit(when)}>
                            <span className="flex-1">{p.label}</span>
                            <span className="tabular text-[11px] text-muted-foreground">
                              {when.toLocaleDateString(undefined, { weekday: 'short' })}{' '}
                              {when.toLocaleTimeString(undefined, {
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                        Or a specific time
                      </DropdownMenuLabel>
                      <div onKeyDown={(e) => e.stopPropagation()}>
                        <CustomTimePicker onPick={(at) => submit(at)} autoFocus={false} />
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  onClick={() => submit()}
                  loading={pending}
                  size="icon-sm"
                  variant={isNote ? 'default' : 'brand'}
                  aria-label="Send"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* The hint has to follow the setting, or it teaches the wrong key. */}
      <p className="hidden items-center gap-1 px-1.5 pt-1.5 text-[10.5px] text-muted-foreground md:flex">
        {viaInbox && (
          <>
            <span className="flex items-center gap-1" title={`Replies go out from ${viaInbox.name}`}>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: viaInbox.color }}
              />
              via {viaInbox.name}
            </span>
            <span className="opacity-40">·</span>
          </>
        )}
        {signaturePreview && !isNote && (
          <>
            <span
              className="flex items-center gap-1"
              title={`Appended when you send:\n\n${signaturePreview}`}
            >
              <PenLine className="h-2.5 w-2.5" />
              signature on
            </span>
            <span className="opacity-40">·</span>
          </>
        )}
        {completion && (
          <>
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">⇥</kbd>
            to complete
            <span className="opacity-40">·</span>
          </>
        )}
        {enterSends ? (
          <>
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">
              <CornerDownLeft className="inline h-2.5 w-2.5" />
            </kbd>
            to send
            <span className="opacity-40">·</span>
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">Shift</kbd>+
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">↵</kbd>
            for a new line
          </>
        ) : (
          <>
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">⌘</kbd>+
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">↵</kbd>
            to send
            <span className="opacity-40">·</span>
            <kbd className="rounded border bg-secondary px-1 font-sans text-[10px]">
              <CornerDownLeft className="inline h-2.5 w-2.5" />
            </kbd>
            for a new line
          </>
        )}
      </p>
    </div>
  );
}
