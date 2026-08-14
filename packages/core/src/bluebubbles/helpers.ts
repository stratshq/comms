/** Parse a BlueBubbles chat GUID like `iMessage;-;+15551234567`. */
export function parseChatGuid(guid: string): {
  service: string;
  isGroup: boolean;
  identifier: string;
} {
  const parts = guid.split(';');
  const service = parts[0] ?? 'iMessage';
  const type = parts[1] ?? '-';
  const identifier = parts.slice(2).join(';');
  return { service, isGroup: type === '+', identifier };
}

/**
 * The other party's address for a direct chat, read out of the chat GUID.
 *
 * A GUID is `service;type;identifier`, and for a 1:1 chat the identifier IS the
 * handle — `iMessage;-;+15551234567`. That means a conversation can always name
 * who it's with, even when every message we've seen is outbound (outbound
 * messages carry no handle at all).
 *
 * Group GUIDs carry an opaque `chat123456` id instead of an address, so they
 * return null — a group has participants, not a single counterparty.
 */
export function addressFromChatGuid(guid: string): string | null {
  const { isGroup, identifier } = parseChatGuid(guid);
  if (isGroup) return null;
  const id = identifier.trim();
  if (!id) return null;
  // Some direct chats still carry a chat-style identifier; it isn't an address.
  if (/^chat\d+$/i.test(id)) return null;
  return id;
}

export type NormalizedIdentity = {
  kind: 'phone' | 'email' | 'handle';
  value: string;
  raw: string;
};

/**
 * Normalize an iMessage handle address into a stable identity key. Emails are
 * lowercased; phone numbers are reduced to digits with a leading `+`. Anything
 * else is kept as an opaque handle.
 */
export function normalizeAddress(address: string): NormalizedIdentity {
  const raw = address.trim();
  if (raw.includes('@')) {
    return { kind: 'email', value: raw.toLowerCase(), raw };
  }
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+?\d{6,}$/.test(digits)) {
    const value = digits.startsWith('+') ? digits : `+${digits}`;
    return { kind: 'phone', value, raw };
  }
  return { kind: 'handle', value: raw, raw };
}

/**
 * A key for deciding whether two addresses are the same person.
 *
 * Storage normalization isn't enough on its own: iMessage hands us E.164
 * (`+15551234567`) while the Mac's address book stores national format
 * (`(555) 123-4567` → `+5551234567`). Comparing those literally never matches,
 * which silently breaks every contact join. Phone numbers therefore match on
 * their last 10 significant digits — enough to identify a person, short enough
 * to survive country-code and formatting differences.
 */
export function phoneMatchKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/** Comparable key for any normalized identity. */
export function addressMatchKey(identity: NormalizedIdentity): string {
  if (identity.kind === 'phone') {
    return `phone:${phoneMatchKey(identity.value) ?? identity.value}`;
  }
  return `${identity.kind}:${identity.value.toLowerCase()}`;
}

/** Convenience: match key straight from a raw address string. */
export function matchKeyForAddress(raw: string): string {
  return addressMatchKey(normalizeAddress(raw));
}

/** Convert a BlueBubbles ms timestamp into a Date (or null for 0 / undefined). */
export function bbDate(ms: number | undefined | null): Date | null {
  if (!ms || ms <= 0) return null;
  return new Date(ms);
}

/**
 * Tapbacks that arrive as ordinary text.
 *
 * Between two iMessage users a tapback is structured data — an
 * `associatedMessageType` pointing at the message it decorates. Over SMS
 * there is no such thing, so Apple sends the literal sentence `Loved "not
 * home!"` as a new message. Without this, loving a green-bubble text posts a
 * message into the thread and makes `Loved "not home!"` the conversation's
 * preview, which is not what happens in Messages and not what anyone means
 * by tapping a heart.
 *
 * Matched strictly — anchored, with the quoted span required — because the
 * cost of a false positive is hiding a real message someone sent.
 */
const TAPBACK_VERBS: Record<string, string> = {
  loved: 'love',
  liked: 'like',
  disliked: 'dislike',
  'laughed at': 'laugh',
  emphasized: 'emphasize',
  emphasised: 'emphasize',
  questioned: 'question',
};

/** "Removed a heart from …" and friends — the undo half. */
const TAPBACK_REMOVALS: Record<string, string> = {
  heart: '-love',
  like: '-like',
  dislike: '-dislike',
  laugh: '-laugh',
  exclamation: '-emphasize',
  question: '-question',
};

export interface TextTapback {
  /** Reaction name, matching `reactionFromAssociatedType`. */
  reaction: string;
  /** The quoted text of the message being reacted to, when it was quoted. */
  target: string | null;
}

export function parseTextTapback(body: string | null | undefined): TextTapback | null {
  const text = body?.trim();
  if (!text) return null;
  // Curly quotes are what Messages actually emits; straight ones show up in
  // relayed and re-encoded copies.
  const quoted = String.raw`[“"](.+)[”"]`;

  const removal = new RegExp(
    `^Removed (?:a|an) (${Object.keys(TAPBACK_REMOVALS).join('|')}) from ${quoted}$`,
    'is',
  ).exec(text);
  if (removal) {
    return {
      reaction: TAPBACK_REMOVALS[removal[1]!.toLowerCase()]!,
      target: removal[2] ?? null,
    };
  }

  const verbs = Object.keys(TAPBACK_VERBS).join('|');
  // Either a quoted message, or the shorthand Apple uses for non-text
  // content: `Loved an image`, `Liked a link`.
  const match = new RegExp(`^(${verbs}) (?:${quoted}|(?:an?) (image|link|attachment|movie))$`, 'is').exec(
    text,
  );
  if (!match) return null;

  return {
    reaction: TAPBACK_VERBS[match[1]!.toLowerCase()]!,
    target: match[2] ?? null,
  };
}

/** Map a BlueBubbles `associatedMessageType` code to a friendly reaction name. */
export function reactionFromAssociatedType(type: number | string | null | undefined): string | null {
  if (type === null || type === undefined) return null;
  const n = typeof type === 'string' ? parseInt(type, 10) : type;
  const map: Record<number, string> = {
    2000: 'love',
    2001: 'like',
    2002: 'dislike',
    2003: 'laugh',
    2004: 'emphasize',
    2005: 'question',
    3000: '-love',
    3001: '-like',
    3002: '-dislike',
    3003: '-laugh',
    3004: '-emphasize',
    3005: '-question',
  };
  return map[n] ?? null;
}
