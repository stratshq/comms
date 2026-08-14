import { describe, it, expect } from 'vitest';
import {
  normalizeAddress,
  parseChatGuid,
  reactionFromAssociatedType,
  parseTextTapback,
  bbDate,
} from '../src/bluebubbles/helpers';

describe('normalizeAddress', () => {
  it('lowercases emails', () => {
    expect(normalizeAddress('Foo@Bar.COM')).toMatchObject({ kind: 'email', value: 'foo@bar.com' });
  });

  it('normalizes phone numbers to +digits', () => {
    expect(normalizeAddress('(555) 123-4567')).toMatchObject({
      kind: 'phone',
      value: '+5551234567',
    });
  });

  it('preserves an existing leading +', () => {
    expect(normalizeAddress('+1 555 123 4567').value).toBe('+15551234567');
  });

  it('falls back to an opaque handle', () => {
    expect(normalizeAddress('some.random.handle').kind).toBe('handle');
  });

  it('keeps the raw value for reference', () => {
    expect(normalizeAddress('  +15551234567 ').raw).toBe('+15551234567');
  });
});

describe('parseChatGuid', () => {
  it('parses an individual iMessage chat', () => {
    expect(parseChatGuid('iMessage;-;+15551234567')).toEqual({
      service: 'iMessage',
      isGroup: false,
      identifier: '+15551234567',
    });
  });

  it('detects a group chat via the + type', () => {
    expect(parseChatGuid('iMessage;+;chat123456')).toMatchObject({ isGroup: true });
  });

  it('handles the newer `any` service prefix', () => {
    expect(parseChatGuid('any;-;+15551234567').service).toBe('any');
  });

  it('keeps emails with special chars intact in the identifier', () => {
    expect(parseChatGuid('iMessage;-;person@icloud.com').identifier).toBe('person@icloud.com');
  });
});

describe('reactionFromAssociatedType', () => {
  it('maps add-reaction codes', () => {
    expect(reactionFromAssociatedType(2000)).toBe('love');
    expect(reactionFromAssociatedType(2003)).toBe('laugh');
  });

  it('maps remove-reaction codes with a - prefix', () => {
    expect(reactionFromAssociatedType(3002)).toBe('-dislike');
  });

  it('accepts numeric strings', () => {
    expect(reactionFromAssociatedType('2001')).toBe('like');
  });

  it('returns null for non-reaction / missing types', () => {
    expect(reactionFromAssociatedType(null)).toBeNull();
    expect(reactionFromAssociatedType(undefined)).toBeNull();
    expect(reactionFromAssociatedType(9999)).toBeNull();
  });
});

describe('bbDate', () => {
  it('converts a ms timestamp to a Date', () => {
    expect(bbDate(1_700_000_000_000)?.getTime()).toBe(1_700_000_000_000);
  });

  it('treats 0 / null / undefined as no date', () => {
    expect(bbDate(0)).toBeNull();
    expect(bbDate(null)).toBeNull();
    expect(bbDate(undefined)).toBeNull();
  });
});

/**
 * Over SMS there is no such thing as a tapback, so Apple sends the sentence
 * instead. Without recognising it, hearting a green-bubble text posts a
 * message into the thread and becomes the conversation's preview.
 */
describe('parseTextTapback', () => {
  it('reads the reaction and the message it decorates', () => {
    expect(parseTextTapback('Loved "not home!"')).toEqual({
      reaction: 'love',
      target: 'not home!',
    });
    expect(parseTextTapback('Laughed at "see you then"')).toEqual({
      reaction: 'laugh',
      target: 'see you then',
    });
    expect(parseTextTapback('Emphasized "bring the keys"')).toEqual({
      reaction: 'emphasize',
      target: 'bring the keys',
    });
  });

  it('handles the curly quotes Messages actually emits', () => {
    expect(parseTextTapback('Liked “not home!”')).toEqual({
      reaction: 'like',
      target: 'not home!',
    });
  });

  it('handles the shorthand for non-text content', () => {
    expect(parseTextTapback('Loved an image')).toEqual({ reaction: 'love', target: null });
    expect(parseTextTapback('Liked a link')).toEqual({ reaction: 'like', target: null });
  });

  it('reads removals as the negative reaction', () => {
    expect(parseTextTapback('Removed a heart from "not home!"')).toEqual({
      reaction: '-love',
      target: 'not home!',
    });
    expect(parseTextTapback('Removed an exclamation from "bring the keys"')).toEqual({
      reaction: '-emphasize',
      target: 'bring the keys',
    });
  });

  /**
   * The expensive direction. A false positive hides a message somebody
   * actually sent, so anything that merely resembles the shape stays a
   * message.
   */
  it('leaves real messages alone', () => {
    expect(parseTextTapback('I loved "The Bear" too')).toBeNull();
    expect(parseTextTapback('Loved it')).toBeNull();
    expect(parseTextTapback('Liked your photo on Instagram')).toBeNull();
    expect(parseTextTapback('she laughed at "the joke" and left')).toBeNull();
    expect(parseTextTapback('Loved')).toBeNull();
    expect(parseTextTapback('')).toBeNull();
    expect(parseTextTapback(null)).toBeNull();
  });
});

/**
 * The guard that decides whether to fall back to text parsing keys on this
 * returning null, not on the raw field being falsy — BlueBubbles sends the
 * STRING "0" for an ordinary message in some payload shapes, and `"0"` is
 * truthy in JavaScript.
 */
describe('reactionFromAssociatedType on non-reactions', () => {
  it('resolves nothing for every way of saying "not a tapback"', () => {
    for (const v of [0, '0', '', null, undefined]) {
      expect(reactionFromAssociatedType(v as never)).toBeNull();
    }
  });

  it('still resolves real codes, as numbers or strings', () => {
    expect(reactionFromAssociatedType(2000)).toBe('love');
    expect(reactionFromAssociatedType('2000')).toBe('love');
    expect(reactionFromAssociatedType(3000)).toBe('-love');
  });
});
