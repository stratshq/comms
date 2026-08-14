/**
 * What kind of correspondent is on the other end.
 *
 * Zero imports on purpose, and exported as its own subpath
 * (`@comms/core/correspondent`) so browser code can use the extractor
 * without the package barrel dragging BullMQ and ioredis into the bundle.
 *
 * A business iMessage number receives three very different streams through
 * one pipe: actual people, machines (delivery notices, appointment reminders,
 * alerts), and verification codes. Email clients get to ignore this because
 * email has senders, subjects and List-Unsubscribe headers; iMessage gives
 * you a phone number and a body, so the classification has to be earned from
 * the traffic itself.
 *
 * The classifier is deliberately one-directional in its confidence: it will
 * happily call something automated, but ANY outbound reply from us, or a
 * named contact, drops it straight back to `person`. A misfiled customer is
 * the only failure that actually costs anything, so every ambiguous signal
 * resolves toward `person`.
 */

export type CorrespondentKind = 'person' | 'unknown' | 'automated' | 'otp';

/** Short codes are 5–6 digits (US/CA) and are never a person. */
const SHORT_CODE_RE = /^\+?\d{5,6}$/;

/**
 * Words that accompany a verification code. Case-insensitive.
 *
 * The second alternative catches the possessive framing — "552310 is your
 * code", "your Acme login code" — which is the most common shape of all and
 * which a strict keyword list misses. Bare "code" on its own stays out: an
 * order confirmation says "code" too.
 */
const OTP_WORDS =
  /\b(?:otp|one[- ]time|verification|verify|passcode|pass ?code|security code|access code|auth(?:entication)? code|confirmation code|2fa|two[- ]factor|login code|sign[- ]?in code)\b|\b(?:is )?your\s+(?:[\w-]+\s+){0,2}code\b/i;

/** "Your code is 123456" / "123456 is your code" / "G-123456". */
const CODE_RE = /\b(?:[A-Z]-)?\d{4,8}\b/;

/** Machine-sent traffic that isn't a code. */
const AUTOMATED_WORDS =
  /\b(?:do not reply|do-not-reply|no[- ]reply|noreply|automated message|this is an automated|unsubscribe|reply stop to|txt stop|msg&data rates|message and data rates|your (?:order|package|delivery|shipment|prescription|appointment)\b.*\b(?:is|has|will)\b)/i;

/**
 * Has a human actually named this contact?
 *
 * Not the same question as "is displayName non-empty". Ingest creates every
 * contact with its own address as the display name, so the column is
 * essentially never blank — meaning a naive check answers yes for a number
 * nobody has ever identified, and the classifier's "a named contact is a
 * person" escape hatch fires for the entire unknown pile.
 *
 * Shared with the contact sync, which needs the same distinction to know
 * whether an address-book name is safe to write over.
 */
export function isRealContactName(
  displayName: string | null | undefined,
  addresses: (string | null | undefined)[] = [],
): boolean {
  const name = displayName?.trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  if (addresses.some((a) => a?.trim().toLowerCase() === lower)) return false;
  // A bare phone number, however formatted, is an address wearing a name's
  // clothes — "+1 (555) 123-4567" is not something a person chose to call them.
  if (/^\+?[\d\s()\-.]+$/.test(name)) return false;
  // An email address is likewise the handle, not a name.
  if (/^[^\s@]+@[^\s@]+$/.test(name)) return false;
  return true;
}

export interface KindSignals {
  /** The sender's address (phone/email/handle) as we know it. */
  address?: string | null;
  /**
   * Whether a human has given this contact a real name — see
   * `isRealContactName`. A contact named after its own phone number does not
   * count, or nothing would ever be classified at all.
   */
  hasContactName?: boolean;
  /** Recent inbound bodies, newest first. A few is plenty. */
  inboundBodies?: (string | null | undefined)[];
  /** Has anyone on our side ever replied in this thread? */
  hasOutbound?: boolean;
  /** Group chats are always people. */
  isGroup?: boolean;
  /** Total inbound messages seen — one message isn't a pattern. */
  inboundCount?: number;
}

/**
 * Extract the verification code from a message, or null.
 *
 * Requires BOTH a code-shaped token and an OTP word, in that message. A bare
 * number is an order total, a street address, or a time — showing a "copy
 * code" chip for those would be noise on real conversations.
 */
export function extractOtpCode(body: string | null | undefined): string | null {
  const text = (body ?? '').trim();
  if (!text) return null;
  if (!OTP_WORDS.test(text)) return null;

  // Prefer a code adjacent to the OTP word over any digits in the message —
  // "your verification code is 402931, valid for 10 minutes" has two numbers.
  const near = text.match(
    /(?:code|otp|passcode|pin)\D{0,20}?\b((?:[A-Z]-)?\d{4,8})\b|\b((?:[A-Z]-)?\d{4,8})\b\D{0,20}?(?:is your|is the)/i,
  );
  const code = near?.[1] ?? near?.[2] ?? text.match(CODE_RE)?.[0];
  if (!code) return null;

  // Years and prices masquerade as codes; a 4-digit token only counts when the
  // message is short enough to be nothing but a code notification.
  if (code.replace(/\D/g, '').length === 4 && text.length > 120) return null;
  return code;
}

/**
 * Classify a conversation from what we know about it.
 *
 * Order matters: the escape hatches (group, named contact, we replied) are
 * checked before any machine heuristic, so a real customer can never be
 * demoted by a keyword they happened to use.
 */
export function classifyCorrespondent(signals: KindSignals): CorrespondentKind {
  const bodies = (signals.inboundBodies ?? []).filter(
    (b): b is string => Boolean(b && b.trim()),
  );

  // Escape hatches first — each one means a human is involved.
  if (signals.isGroup) return 'person';
  if (signals.hasContactName) return 'person';
  // We wrote back, so whatever it is, it's a correspondent.
  if (signals.hasOutbound) return 'person';

  const address = (signals.address ?? '').replace(/[\s()-]/g, '');
  const isShortCode = SHORT_CODE_RE.test(address);

  // OTP: the newest message is a code notification. Checked on the LATEST
  // message rather than the history, because a thread that sent codes last
  // month and a real message today is a real message today.
  const latest = bodies[0];
  if (latest && extractOtpCode(latest)) return 'otp';

  // Automated: machine phrasing, or a short code we've never answered.
  const anyAutomated = bodies.some((b) => AUTOMATED_WORDS.test(b));
  if (anyAutomated) return 'automated';
  if (isShortCode) return 'automated';

  // Unknown: nobody has named them and there's no pattern to go on. One
  // message is not enough to call anything, so this is where new threads land.
  return 'unknown';
}
