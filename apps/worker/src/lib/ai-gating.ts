/**
 * The rules that decide whether a conversation is worth a model call.
 *
 * Kept pure and kept here rather than inline in the processor, because these
 * predicates are the only thing standing between a busy inbox and a pair of
 * model calls for every text that arrives — including the ones for threads
 * nobody will ever open. They should be readable and testable on their own.
 */

export type ConversationKind = 'person' | 'unknown' | 'automated' | 'otp';
export type ConversationStatus = 'open' | 'pending' | 'snoozed' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface DraftGateInput {
  kind: ConversationKind;
  status: ConversationStatus;
  /** Set when the thread has been permanently silenced. */
  mutedAt: Date | null;
  /** Direction of the newest message, or null when the thread is empty. */
  lastDirection: 'inbound' | 'outbound' | null;
}

/**
 * Should we spend a call drafting a reply to this thread?
 *
 * Only for conversations a person is plausibly going to answer. The expensive
 * mistake this prevents is the common one: a delivery-notice number that texts
 * four times a day, or a 2FA sender nobody has replied to in the history of
 * the product, each quietly buying a draft reply and a catch-up summary.
 */
export function shouldDraftReply(conv: DraftGateInput): boolean {
  // Machine traffic is never replied to. That is the whole definition of the
  // class — see the `conversation_kind` enum.
  if (conv.kind === 'automated' || conv.kind === 'otp') return false;
  // A closed thread is a decision someone made. Reopening it is a deliberate
  // act, and the draft can be computed then.
  if (conv.status === 'closed') return false;
  // Muted means "stay visible, stay quiet". A draft is not quiet: it is work
  // done on your behalf for a thread you said you did not want to think about.
  if (conv.mutedAt) return false;
  // Nothing to reply to when the last word was already ours.
  if (conv.lastDirection !== 'inbound') return false;
  return true;
}

/**
 * Should we spend a call re-classifying this thread?
 *
 * Same machine-traffic exclusion — a topic and a sentiment for a stream of
 * verification codes is a classification nobody reads. Closed and muted
 * threads still qualify: unlike a draft, the classification is what folder
 * membership and reporting are built on, and those should stay honest about a
 * thread whether or not anyone intends to reply to it.
 */
export function shouldTriage(kind: ConversationKind): boolean {
  return kind !== 'automated' && kind !== 'otp';
}

/**
 * Has anything arrived since the last time this thread was classified?
 *
 * Re-triage is queued per inbound message and collapsed per burst, so by the
 * time a job runs another may already have covered the same messages. Without
 * this the duplicate costs a model call to produce the answer we already have.
 */
export function isTriageStale(input: {
  /** When triage last ran, from `metadata.ai.triagedAt`. */
  triagedAt: Date | null;
  /** The conversation's newest inbound message. */
  lastInboundAt: Date | null;
}): boolean {
  if (!input.triagedAt) return true; // never classified
  if (!input.lastInboundAt) return false; // nothing has ever come in
  return input.lastInboundAt > input.triagedAt;
}

/**
 * May the model set this conversation's priority?
 *
 * Yes while the priority is still the default, and yes while it is exactly
 * what the model itself last chose — a value no human has since overridden.
 * The second clause is what re-triage needs: without it a thread the model
 * once called `urgent` could never come back down, because the act of raising
 * it made it permanently ineligible.
 *
 * A human's choice is final either way. It stops matching what the model last
 * set, and from then on the model is only ever a suggestion.
 */
export function modelMaySetPriority(input: {
  current: Priority;
  /** What the model last chose, from `metadata.ai.priority`. */
  modelChose: Priority | null;
}): boolean {
  return input.current === 'normal' || input.current === input.modelChose;
}
