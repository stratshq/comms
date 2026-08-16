'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Sparkles, FileText, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  improveDraftAction,
  summarizeConversationAction,
  suggestReplyAction,
} from '@/server/actions/ai';

export function AiAssist({
  conversationId,
  draft,
  onDraft,
}: {
  conversationId: string;
  /** What's currently in the composer. Decides whether AI writes or edits. */
  draft?: string;
  onDraft: (text: string) => void;
}) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  // Track which button fired so only that one shows a spinner.
  const [active, setActive] = useState<'suggest' | 'summarize' | null>(null);

  // Writing from scratch is only the right offer when there is nothing to work
  // from. Once you have typed something, a suggestion that replaces it is a
  // worse deal than one that sharpens it — you already know what you mean.
  const hasDraft = Boolean(draft?.trim());

  function suggest() {
    setActive('suggest');
    start(async () => {
      if (hasDraft) {
        const previous = draft ?? '';
        const res = await improveDraftAction({ conversationId, draft: previous });
        if (res.ok) {
          onDraft(res.text);
          // Their words were on screen a moment ago and are now gone. One
          // click has to be enough to get them back.
          toast.success('Draft rewritten — review before sending.', {
            action: { label: 'Undo', onClick: () => onDraft(previous) },
          });
        } else {
          toast.error(res.error);
        }
      } else {
        const res = await suggestReplyAction(conversationId);
        if (res.ok) {
          onDraft(res.text);
          toast.success('Draft inserted — review before sending.');
        } else {
          toast.error(res.error);
        }
      }
      setActive(null);
    });
  }

  function summarize() {
    setActive('summarize');
    start(async () => {
      const res = await summarizeConversationAction(conversationId);
      if (res.ok) setSummary(res.text);
      else toast.error(res.error);
      setActive(null);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="gap-1.5 text-brand hover:bg-brand-muted hover:text-brand"
        onClick={suggest}
        loading={pending && active === 'suggest'}
        disabled={pending}
        title={
          hasDraft
            ? 'Rewrite what you have written — same meaning, better wording'
            : 'Draft a reply to the latest messages'
        }
      >
        {hasDraft ? <Wand2 className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        {hasDraft ? 'Improve' : 'Suggest reply'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="gap-1.5"
        onClick={summarize}
        loading={pending && active === 'summarize'}
        disabled={pending}
      >
        <FileText className="h-3.5 w-3.5" />
        Summarize
      </Button>

      <Dialog open={summary !== null} onOpenChange={(o) => !o && setSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-muted text-brand">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              Conversation summary
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap pt-2 text-[13.5px] leading-relaxed text-foreground">
              {summary}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
