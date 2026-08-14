/**
 * One place that decides what a conversation is called.
 *
 * Previously each surface did `contact?.displayName ?? title ?? 'Unknown'`,
 * which is subtly wrong: `??` only falls through on null/undefined, and
 * BlueBubbles sends an EMPTY STRING as the display name for any chat the user
 * never named — which is most of them. The chain returned '' and the row
 * rendered blank.
 */

/**
 * The title `repairBlankNames` writes for an unnamed group. It is a
 * last-resort label, not a name someone chose, so naming treats it as absent
 * and prefers the member list when we have one.
 */
const GROUP_PLACEHOLDER = 'group conversation';

/** Treat empty and whitespace-only strings as absent. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Human-readable form of a raw handle. A phone number is a perfectly good
 * label when we have no name — far better than "Unknown".
 */
export function formatAddress(address: string | null | undefined): string | null {
  const raw = present(address);
  if (!raw) return null;
  if (raw.includes('@')) return raw;

  const digits = raw.replace(/\D/g, '');
  // US/Canada, with or without the country code.
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Anything else: keep the leading + so it reads as a phone number.
  return raw.startsWith('+') ? raw : digits.length > 6 ? `+${digits}` : raw;
}

/**
 * The address embedded in a BlueBubbles chat GUID (`iMessage;-;+15551234567`).
 *
 * This is the last line of defence for naming: it needs no contact row, no
 * join, and no network call, because every conversation stores its GUID. A
 * thread should never render as "Unknown contact" while the number is sitting
 * right there in a column we already have.
 *
 * Kept dependency-free rather than imported from @comms/core so this module
 * stays safe to use from client components.
 */
export function addressFromChatGuid(guid: string | null | undefined): string | null {
  const raw = present(guid);
  if (!raw) return null;
  const parts = raw.split(';');
  if (parts.length < 3) return null;
  if (parts[1] === '+') return null; // group: the identifier is an opaque id
  const identifier = present(parts.slice(2).join(';'));
  if (!identifier || /^chat\d+$/i.test(identifier)) return null;
  return identifier;
}

export interface NameableConversation {
  contactName?: string | null;
  /** The contact's first known address, used when there's no name. */
  contactAddress?: string | null;
  /**
   * The provider chat GUID. Carries the address for a 1:1 thread, so naming
   * still works when contact resolution failed entirely.
   */
  chatGuid?: string | null;
  title?: string | null;
  isGroup?: boolean | null;
  /** Group participant names/addresses, for building "Ana, Ben +2". */
  participants?: Array<string | null | undefined>;
}

/** Best address we know for a 1:1 thread, contact row or not. */
export function conversationAddress(c: NameableConversation): string | null {
  return present(c.contactAddress) ?? addressFromChatGuid(c.chatGuid);
}

/** The label to show for a conversation. Never returns an empty string. */
export function conversationName(c: NameableConversation): string {
  const rawTitle = present(c.title);
  const title =
    rawTitle && rawTitle.toLowerCase() === GROUP_PLACEHOLDER ? null : rawTitle;

  if (c.isGroup) {
    // A contact name is never the answer for a group, even when one is
    // attached. A group has participants, not a counterparty, so letting
    // `contactName` win here labelled the whole thread with whichever member
    // happened to get linked to it.
    if (title) return title;
    const names = (c.participants ?? [])
      .map((p) => present(p) && (formatAddress(p) ?? present(p)))
      .filter((p): p is string => Boolean(p));
    if (names.length === 1) return names[0]!;
    if (names.length === 2) return `${names[0]}, ${names[1]}`;
    if (names.length > 2) return `${names[0]}, ${names[1]} +${names.length - 2}`;
    return 'Group conversation';
  }

  const contactName = present(c.contactName);
  if (contactName) return contactName;

  // A phone number beats a generic placeholder for a 1:1 thread.
  const address = formatAddress(conversationAddress(c));
  if (address) return address;
  if (title) return title;
  return 'Unknown contact';
}

/** Initials source — avoids "UN" for every unnamed thread. */
export function nameForInitials(c: NameableConversation): string {
  // Same rule as `conversationName`: a group's initials come from the group.
  if (c.isGroup) {
    const t = present(c.title);
    return t && t.toLowerCase() !== GROUP_PLACEHOLDER ? t : 'Group';
  }
  const contactName = present(c.contactName);
  if (contactName) return contactName;
  const digits = conversationAddress(c)?.replace(/\D/g, '');
  // Last two digits read better than "UN" repeated down the list.
  if (digits && digits.length >= 2) return digits.slice(-2);
  return present(c.title) ?? '?';
}
