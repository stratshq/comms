import { describe, it, expect } from 'vitest';
import {
  addressFromChatGuid,
  conversationAddress,
  conversationName,
  formatAddress,
  nameForInitials,
} from '../src/lib/naming';

describe('conversationName', () => {
  it('never returns an empty string when the name is blank — the blank-row bug', () => {
    // BlueBubbles sends '' for any chat the user never named.
    expect(conversationName({ contactName: '', title: '' })).not.toBe('');
    expect(conversationName({ contactName: '   ', title: '   ' })).not.toBe('');
  });

  it('falls through an empty contact name to the phone number', () => {
    expect(conversationName({ contactName: '', contactAddress: '+15551234567' })).toBe(
      '(555) 123-4567',
    );
  });

  it('prefers a real contact name above everything', () => {
    expect(
      conversationName({ contactName: 'Jordan Blake', contactAddress: '+15551234567' }),
    ).toBe('Jordan Blake');
  });

  it('shows the number rather than "Unknown" for an unnamed 1:1', () => {
    expect(conversationName({ contactAddress: '+15551234567' })).toBe('(555) 123-4567');
  });

  it('builds a name from participants for an unnamed group', () => {
    expect(
      conversationName({ isGroup: true, title: '', participants: ['Ana', 'Ben'] }),
    ).toBe('Ana, Ben');
    expect(
      conversationName({ isGroup: true, participants: ['Ana', 'Ben', 'Cal', 'Dee'] }),
    ).toBe('Ana, Ben +2');
  });

  it('uses a group title when it has one', () => {
    expect(conversationName({ isGroup: true, title: 'Weekend plans' })).toBe('Weekend plans');
  });

  it('falls back sensibly with nothing at all', () => {
    expect(conversationName({})).toBe('Unknown contact');
    expect(conversationName({ isGroup: true })).toBe('Group conversation');
  });
});

describe('formatAddress', () => {
  it('formats US numbers with and without the country code', () => {
    expect(formatAddress('+15551234567')).toBe('(555) 123-4567');
    expect(formatAddress('5551234567')).toBe('(555) 123-4567');
  });

  it('leaves emails alone', () => {
    expect(formatAddress('jordan@acme.com')).toBe('jordan@acme.com');
  });

  it('keeps international numbers recognisable', () => {
    expect(formatAddress('+442071234567')).toBe('+442071234567');
  });

  it('returns null for blank input', () => {
    expect(formatAddress('')).toBeNull();
    expect(formatAddress(null)).toBeNull();
  });
});

describe('nameForInitials', () => {
  it('uses the name when present', () => {
    expect(nameForInitials({ contactName: 'Jordan Blake' })).toBe('Jordan Blake');
  });

  it('uses trailing digits rather than a generic placeholder', () => {
    expect(nameForInitials({ contactAddress: '+15551234567' })).toBe('67');
  });
});

describe('addressFromChatGuid — the "Unknown contact" fix', () => {
  it('reads the number out of a 1:1 chat guid', () => {
    expect(addressFromChatGuid('iMessage;-;+15551234567')).toBe('+15551234567');
    expect(addressFromChatGuid('SMS;-;+15551234567')).toBe('+15551234567');
  });

  it('reads an email handle', () => {
    expect(addressFromChatGuid('iMessage;-;jordan@acme.com')).toBe('jordan@acme.com');
  });

  it('returns null for a group, whose identifier is an opaque id', () => {
    expect(addressFromChatGuid('iMessage;+;chat483920174')).toBeNull();
    // Some group chats arrive with a '-' type but still carry a chat id.
    expect(addressFromChatGuid('iMessage;-;chat483920174')).toBeNull();
  });

  it('returns null for junk', () => {
    expect(addressFromChatGuid('')).toBeNull();
    expect(addressFromChatGuid(null)).toBeNull();
    expect(addressFromChatGuid('iMessage;-;')).toBeNull();
    expect(addressFromChatGuid('nonsense')).toBeNull();
  });
});

describe('naming survives a conversation with no contact row at all', () => {
  // This is the exact production case: every ingested message was outbound, so
  // no handle was ever seen and contact_id stayed null.
  const orphan = { contactName: null, contactAddress: null, chatGuid: 'iMessage;-;+15551234567' };

  it('shows the number instead of "Unknown contact"', () => {
    expect(conversationName(orphan)).toBe('(555) 123-4567');
  });

  it('still gives real initials', () => {
    expect(nameForInitials(orphan)).toBe('67');
  });

  it('prefers a linked contact address when one exists', () => {
    expect(
      conversationAddress({ contactAddress: '+15559876543', chatGuid: 'iMessage;-;+15551234567' }),
    ).toBe('+15559876543');
  });

  it('does not invent an address for a group', () => {
    expect(conversationName({ isGroup: true, chatGuid: 'iMessage;+;chat483920174' })).toBe(
      'Group conversation',
    );
  });
});

/**
 * A group is its members, never one of them.
 *
 * Regression: `conversationName` checked `contactName` before anything else,
 * so a group that had somehow been linked to a contact rendered under that
 * one member's name — the whole thread relabelled as a single person.
 */
describe('group naming never borrows a member', () => {
  it('ignores contactName for a group, even when one is attached', () => {
    expect(
      conversationName({
        contactName: 'Ana Ruiz',
        isGroup: true,
        title: 'Weekend Trip',
        chatGuid: 'iMessage;+;chat123',
      }),
    ).toBe('Weekend Trip');
  });

  it('falls to members rather than a member-shaped contact name', () => {
    expect(
      conversationName({
        contactName: 'Ana Ruiz',
        isGroup: true,
        title: null,
        participants: ['Ana Ruiz', 'Ben Cole', 'Cara Diaz'],
      }),
    ).toBe('Ana Ruiz, Ben Cole +1');
  });

  it('treats the "Group conversation" placeholder as no title', () => {
    // repairBlankNames writes that string; it is a fallback label, not a name
    // someone chose, so real member names must still win over it.
    expect(
      conversationName({
        isGroup: true,
        title: 'Group conversation',
        participants: ['Ana Ruiz', 'Ben Cole'],
      }),
    ).toBe('Ana Ruiz, Ben Cole');
  });

  it('still says "Group conversation" when there is nothing else', () => {
    expect(conversationName({ isGroup: true, title: 'Group conversation' })).toBe(
      'Group conversation',
    );
  });

  it('keeps using the contact name for a one-to-one', () => {
    expect(
      conversationName({ contactName: 'Ana Ruiz', isGroup: false, chatGuid: 'iMessage;-;+15551234567' }),
    ).toBe('Ana Ruiz');
  });

  it('takes group initials from the group, not a member', () => {
    expect(nameForInitials({ contactName: 'Ana Ruiz', isGroup: true, title: 'Weekend Trip' })).toBe(
      'Weekend Trip',
    );
    expect(nameForInitials({ contactName: 'Ana Ruiz', isGroup: true, title: 'Group conversation' })).toBe(
      'Group',
    );
  });
});

/**
 * Ingest names every new contact after its own phone number, so "has a
 * contact name" is not the same as "has a name". Preferring the placeholder
 * rendered threads as a raw `+16268233242` when `(626) 823-3242` was one call
 * away.
 */
describe('placeholder contact names lose to the formatter', () => {
  it('formats the number instead of echoing the E.164 placeholder', () => {
    expect(
      conversationName({
        contactName: '+16268233242',
        contactAddress: '+16268233242',
        chatGuid: 'iMessage;-;+16268233242',
      }),
    ).toBe('(626) 823-3242');
  });

  it('ignores a placeholder written in any format', () => {
    expect(
      conversationName({
        contactName: '1(626)823-3242',
        contactAddress: '+16268233242',
      }),
    ).toBe('(626) 823-3242');
  });

  it('still prefers a name a human actually gave them', () => {
    expect(
      conversationName({ contactName: 'Karla Ojeda', contactAddress: '+16268233242' }),
    ).toBe('Karla Ojeda');
  });

  it('takes initials from the digits, not from a placeholder name', () => {
    expect(
      nameForInitials({ contactName: '+16268233242', contactAddress: '+16268233242' }),
    ).toBe('42');
  });
});
