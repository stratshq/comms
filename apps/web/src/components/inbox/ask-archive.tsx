'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Sparkles, CornerDownLeft, Loader2 } from 'lucide-react';
import { askArchiveAction, type ArchiveSource } from '@/server/actions/ai';
import { cn } from '@/lib/utils';

const EXAMPLES = [
  'what did we agree on about the deposit?',
  'who asked about availability this month?',
  'what address did they send me?',
];

/**
 * Ask a question of the whole message archive.
 *
 * The answer always ships with the conversations it came from. An AI answer
 * about your own history that you cannot check is worse than no answer — this
 * is the one place where being able to verify matters more than being fast.
 */
export function AskArchive() {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<ArchiveSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setAsked(trimmed);
    setAnswer(null);
    setSources([]);
    setError(null);
    start(async () => {
      const res = await askArchiveAction(trimmed);
      if (res.ok) {
        setAnswer(res.answer);
        setSources(res.sources);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Sparkles className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground/70" />
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }}
          rows={2}
          placeholder="Ask anything about your messages…"
          className="type-body w-full resize-none rounded-xl border bg-surface py-3 pl-10 pr-12 outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-brand"
        />
        <button
          type="button"
          onClick={() => ask(question)}
          disabled={!question.trim() || pending}
          aria-label="Ask"
          className="absolute right-2.5 top-2.5 grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CornerDownLeft className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {!asked && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setQuestion(e);
                ask(e);
              }}
              className="type-caption rounded-full border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <p className="type-body flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading your messages…
        </p>
      )}

      {error && (
        <p className="type-body rounded-xl border border-destructive/40 bg-destructive-muted px-3 py-2 text-destructive">
          {error}
        </p>
      )}

      {answer && (
        <div className="space-y-3">
          <div className="rounded-xl border bg-surface p-4">
            <p className="type-body whitespace-pre-wrap">{answer}</p>
          </div>

          {sources.length > 0 && (
            <div>
              <p className="type-micro pb-1.5 text-muted-foreground/60">
                From these conversations
              </p>
              <div className="divide-y rounded-xl border">
                {sources.map((s) => (
                  <Link
                    key={s.index}
                    href={`/inbox/${s.conversationId}`}
                    className={cn(
                      'flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-accent/60',
                    )}
                  >
                    <span className="type-caption tabular mt-0.5 shrink-0 text-muted-foreground/60">
                      [{s.index}]
                    </span>
                    <span className="min-w-0">
                      <span className="type-title block truncate">{s.conversationName}</span>
                      <span className="type-body block truncate text-muted-foreground">
                        {s.snippet}
                      </span>
                    </span>
                    <span className="type-caption tabular ml-auto shrink-0 text-muted-foreground/60">
                      {s.at}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
