import { describe, it, expect } from 'vitest';
import {
  ageLabel,
  formatTranscript,
  RECENT_MARKER,
  type TranscriptMessage,
} from '../src/transcript.js';

const NOW = new Date('2026-08-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('ageLabel', () => {
  it('reads in the units people think in', () => {
    expect(ageLabel(ago(5 * MINUTE), NOW)).toBe('just now');
    expect(ageLabel(ago(5 * HOUR), NOW)).toBe('earlier today');
    expect(ageLabel(ago(30 * HOUR), NOW)).toBe('yesterday');
    expect(ageLabel(ago(4 * DAY), NOW)).toBe('4 days ago');
    expect(ageLabel(ago(9 * DAY), NOW)).toBe('last week');
    expect(ageLabel(ago(21 * DAY), NOW)).toBe('3 weeks ago');
    expect(ageLabel(ago(210 * DAY), NOW)).toBe('7 months ago');
    expect(ageLabel(ago(800 * DAY), NOW)).toBe('2 years ago');
  });

  it('treats clock skew as now rather than as the future', () => {
    expect(ageLabel(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe('just now');
  });
});

describe('formatTranscript', () => {
  it('stamps age only when the bucket changes', () => {
    const messages: TranscriptMessage[] = [
      { role: 'contact', text: 'is the room still free', at: ago(210 * DAY) },
      { role: 'agent', text: 'yes it is', at: ago(210 * DAY) },
      { role: 'contact', text: 'can you grab milk', at: ago(20 * MINUTE) },
    ];

    expect(formatTranscript(messages, 'Ana', { now: NOW })).toBe(
      [
        '[7 months ago]',
        'Ana: is the room still free',
        'Agent: yes it is',
        '[just now]',
        'Ana: can you grab milk',
      ].join('\n'),
    );
  });

  it('marks the recent window, counting only rendered messages', () => {
    const messages: TranscriptMessage[] = [
      { role: 'contact', text: 'one' },
      { role: 'contact', text: '   ' }, // dropped, must not consume the window
      { role: 'contact', text: 'two' },
      { role: 'contact', text: 'three' },
    ];

    expect(formatTranscript(messages, 'Ana', { now: NOW, recentCount: 2 })).toBe(
      ['Ana: one', RECENT_MARKER, 'Ana: two', 'Ana: three'].join('\n'),
    );
  });

  it('re-stamps the age of the first message below the marker', () => {
    const messages: TranscriptMessage[] = [
      { role: 'contact', text: 'old one', at: ago(210 * DAY) },
      { role: 'contact', text: 'old two', at: ago(210 * DAY) },
      { role: 'contact', text: 'still the same bucket', at: ago(210 * DAY) },
    ];

    // Without the re-stamp the live line would sit under no heading at all,
    // having inherited one that is now above a divider.
    expect(formatTranscript(messages, 'Ana', { now: NOW, recentCount: 1 })).toBe(
      [
        '[7 months ago]',
        'Ana: old one',
        'Ana: old two',
        RECENT_MARKER,
        '[7 months ago]',
        'Ana: still the same bucket',
      ].join('\n'),
    );
  });

  it('omits the marker when everything is already recent', () => {
    const messages: TranscriptMessage[] = [{ role: 'contact', text: 'hi' }];
    expect(formatTranscript(messages, 'Ana', { now: NOW, recentCount: 10 })).toBe('Ana: hi');
  });

  it('renders roles, authors and empty input as before', () => {
    expect(formatTranscript([], 'Ana')).toBe('');
    expect(
      formatTranscript(
        [
          { role: 'contact', text: 'hello' },
          { role: 'agent', author: 'Sam', text: 'hi there' },
          { role: 'note', text: 'VIP' },
          { role: 'system', text: 'merged' },
        ],
        null,
      ),
    ).toBe(
      ['Customer: hello', 'Agent (Sam): hi there', '[internal note] VIP', '[system] merged'].join(
        '\n',
      ),
    );
  });

  it('accepts an ISO string as well as a Date, and ignores an unparseable one', () => {
    expect(
      formatTranscript([{ role: 'contact', text: 'hi', at: ago(30 * HOUR).toISOString() }], 'Ana', {
        now: NOW,
      }),
    ).toBe(['[yesterday]', 'Ana: hi'].join('\n'));

    expect(
      formatTranscript([{ role: 'contact', text: 'hi', at: 'not a date' }], 'Ana', { now: NOW }),
    ).toBe('Ana: hi');
  });
});
