export interface TranscriptMessage {
  role: 'contact' | 'agent' | 'note' | 'system';
  author?: string | null;
  text: string;
  /**
   * When it was sent.
   *
   * Optional so callers that genuinely have no clock still work, but supply it
   * wherever you can: without it a message from March and a message from ten
   * minutes ago read to the model as equally current, and it will happily
   * answer a question that was settled months back.
   */
  at?: Date | string | null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A coarse, human-scale age — the unit people actually think in.
 *
 * Deliberately blunt. The model does not need to know a message landed at
 * 14:07; it needs to know it landed *seven months ago* and is therefore
 * probably about a situation that has since resolved.
 */
export function ageLabel(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  // Clock skew between the DB and the app should read as "now", not "in -3 days".
  if (ms < HOUR) return 'just now';
  if (ms < DAY) return 'earlier today';
  if (ms < 2 * DAY) return 'yesterday';
  const days = Math.floor(ms / DAY);
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/**
 * The marker that separates thread history from the live exchange.
 *
 * Exported because the prompts have to name it exactly — a divider the system
 * prompt refers to by a slightly different string is just another line of
 * transcript.
 */
export const RECENT_MARKER = '--- recent ---';

function renderLine(m: TranscriptMessage, contactName?: string | null): string {
  switch (m.role) {
    case 'contact':
      return `${contactName ?? 'Customer'}: ${m.text}`;
    case 'agent':
      return `Agent${m.author ? ` (${m.author})` : ''}: ${m.text}`;
    case 'note':
      return `[internal note] ${m.text}`;
    default:
      return `[system] ${m.text}`;
  }
}

function toDate(at: TranscriptMessage['at']): Date | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Render a conversation transcript into a compact, model-friendly plain-text
 * form, oldest first.
 *
 * Age is stamped only when the bucket CHANGES, so a burst of texts sent in one
 * evening costs one line rather than forty, and the stamps that do appear mark
 * the real seams in the conversation — which is exactly where a thread stops
 * being about what it used to be about.
 */
export function formatTranscript(
  messages: TranscriptMessage[],
  contactName?: string | null,
  opts: {
    now?: Date;
    /**
     * Draw {@link RECENT_MARKER} before the last N messages. Prompts that have
     * to act on the conversation — drafting a reply, polishing one — use this
     * to tell the live exchange from the history behind it.
     */
    recentCount?: number;
  } = {},
): string {
  const kept = messages.filter((m) => m.text && m.text.trim());
  if (kept.length === 0) return '';

  const now = opts.now ?? new Date();
  // No marker when it would land at the very top: "everything is recent" is
  // said better by saying nothing.
  const recentFrom =
    opts.recentCount && opts.recentCount < kept.length ? kept.length - opts.recentCount : -1;

  const lines: string[] = [];
  let lastAge: string | null = null;

  kept.forEach((m, i) => {
    if (i === recentFrom) {
      lines.push(RECENT_MARKER);
      // Re-stamp below the divider; the first recent line is the one whose age
      // matters most and it should never inherit a heading from above.
      lastAge = null;
    }
    const at = toDate(m.at);
    if (at) {
      const age = ageLabel(at, now);
      if (age !== lastAge) {
        lines.push(`[${age}]`);
        lastAge = age;
      }
    }
    lines.push(renderLine(m, contactName));
  });

  return lines.join('\n');
}
