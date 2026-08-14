import { describe, it, expect } from 'vitest';
import { sanitizeQuery, describeQuery, operatorsFor, type FolderQuery } from '@comms/db/query';
import { matchesQuery, type QueryRow } from '../src/lib/folder-query';

const row = (over: Partial<QueryRow> = {}): QueryRow => ({
  kind: 'person',
  status: 'open',
  priority: 'normal',
  inboxId: 'ibx_1',
  assigneeId: null,
  unreadCount: 0,
  mutedAt: null,
  slaBreachedAt: null,
  lastMessagePreview: 'Can you send the invoice?',
  title: null,
  readNoReply: false,
  hasPhoto: false,
  hasAttachment: false,
  hasVoice: false,
  hasLink: false,
  pinned: false,
  tagIds: [],
  ...over,
});

const q = (match: 'all' | 'any', ...conditions: FolderQuery['conditions']): FolderQuery => ({
  match,
  conditions,
});

describe('sanitizeQuery', () => {
  it('drops conditions with no value, so they cannot read as "no restriction"', () => {
    expect(sanitizeQuery(q('all', { field: 'kind', operator: 'is', value: '  ' }))).toBeNull();
    const mixed = sanitizeQuery(
      q(
        'all',
        { field: 'kind', operator: 'is', value: 'otp' },
        { field: 'priority', operator: 'is', value: '' },
      ),
    );
    expect(mixed?.conditions).toHaveLength(1);
  });

  it('rejects a field nobody defined', () => {
    const bogus = { field: 'zodiac', operator: 'is', value: 'leo' } as never;
    expect(sanitizeQuery(q('all', bogus))).toBeNull();
  });

  it('normalises the match mode and trims values', () => {
    const out = sanitizeQuery({
      match: 'sideways' as never,
      conditions: [{ field: 'words', operator: 'contains', value: '  refund ' }],
    });
    expect(out).toEqual({
      match: 'all',
      conditions: [{ field: 'words', operator: 'contains', value: 'refund' }],
    });
  });
});

describe('matchesQuery', () => {
  it('treats an empty query as no query at all', () => {
    expect(matchesQuery(null, row())).toBe(true);
    expect(matchesQuery(q('all'), row())).toBe(true);
  });

  it('ANDs under match: all', () => {
    const query = q(
      'all',
      { field: 'kind', operator: 'is', value: 'person' },
      { field: 'unread', operator: 'is', value: 'true' },
    );
    expect(matchesQuery(query, row({ unreadCount: 3 }))).toBe(true);
    expect(matchesQuery(query, row({ unreadCount: 0 }))).toBe(false);
  });

  it('ORs under match: any', () => {
    const query = q(
      'any',
      { field: 'priority', operator: 'is', value: 'urgent' },
      { field: 'pinned', operator: 'is', value: 'true' },
    );
    expect(matchesQuery(query, row({ priority: 'urgent' }))).toBe(true);
    expect(matchesQuery(query, row({ pinned: true }))).toBe(true);
    expect(matchesQuery(query, row())).toBe(false);
  });

  it('negates enum fields with is_not', () => {
    const query = q('all', { field: 'kind', operator: 'is_not', value: 'otp' });
    expect(matchesQuery(query, row({ kind: 'person' }))).toBe(true);
    expect(matchesQuery(query, row({ kind: 'otp' }))).toBe(false);
  });

  it('reads boolean polarity from the value, not the operator', () => {
    const off = q('all', { field: 'muted', operator: 'is', value: 'false' });
    expect(matchesQuery(off, row({ mutedAt: null }))).toBe(true);
    expect(matchesQuery(off, row({ mutedAt: new Date() }))).toBe(false);
  });

  it('matches words case-insensitively across the preview and the title', () => {
    const query = q('all', { field: 'words', operator: 'contains', value: 'INVOICE' });
    expect(matchesQuery(query, row())).toBe(true);
    expect(matchesQuery(query, row({ lastMessagePreview: 'hi', title: 'Invoice thread' }))).toBe(
      true,
    );
    expect(matchesQuery(query, row({ lastMessagePreview: 'hi', title: null }))).toBe(false);
  });

  it('inverts free text with not_contains', () => {
    const query = q('all', { field: 'words', operator: 'not_contains', value: 'invoice' });
    expect(matchesQuery(query, row())).toBe(false);
    expect(matchesQuery(query, row({ lastMessagePreview: 'thanks!' }))).toBe(true);
  });

  it('resolves assignee "me" against the viewer, and "unassigned" against nobody', () => {
    const mine = q('all', { field: 'assignee', operator: 'is', value: 'me' });
    expect(matchesQuery(mine, row({ assigneeId: 'usr_1' }), { currentUserId: 'usr_1' })).toBe(true);
    expect(matchesQuery(mine, row({ assigneeId: 'usr_2' }), { currentUserId: 'usr_1' })).toBe(false);
    // No viewer in context must not silently match every assigned thread.
    expect(matchesQuery(mine, row({ assigneeId: 'usr_1' }))).toBe(false);

    const nobody = q('all', { field: 'assignee', operator: 'is', value: 'unassigned' });
    expect(matchesQuery(nobody, row())).toBe(true);
    expect(matchesQuery(nobody, row({ assigneeId: 'usr_1' }))).toBe(false);
  });

  it('matches a tag by id', () => {
    const query = q('all', { field: 'tag', operator: 'is', value: 'tag_vip' });
    expect(matchesQuery(query, row({ tagIds: ['tag_vip', 'tag_x'] }))).toBe(true);
    expect(matchesQuery(query, row({ tagIds: ['tag_x'] }))).toBe(false);
  });

  it('reads the has-media flags', () => {
    const query = q('all', { field: 'has', operator: 'is', value: 'voice' });
    expect(matchesQuery(query, row({ hasVoice: true }))).toBe(true);
    expect(matchesQuery(query, row({ hasAttachment: true }))).toBe(false);
  });

  it('never lets an unknown field widen a folder, even negated', () => {
    const bogus = { field: 'zodiac', operator: 'is_not', value: 'leo' } as never;
    // sanitizeQuery strips it, so the query is empty — but with a real
    // condition alongside it the folder must still narrow, never widen.
    const query = q('all', bogus, { field: 'kind', operator: 'is', value: 'otp' });
    expect(matchesQuery(query, row({ kind: 'otp' }))).toBe(true);
    expect(matchesQuery(query, row({ kind: 'person' }))).toBe(false);
  });
});

describe('operatorsFor', () => {
  it('offers text operators for text, one operator for booleans, is/is not otherwise', () => {
    expect(operatorsFor('words')).toEqual(['contains', 'not_contains']);
    expect(operatorsFor('unread')).toEqual(['is']);
    expect(operatorsFor('kind')).toEqual(['is', 'is_not']);
  });
});

describe('describeQuery', () => {
  it('reads as the sentence the builder shows', () => {
    expect(
      describeQuery(
        q(
          'any',
          { field: 'priority', operator: 'is', value: 'urgent' },
          { field: 'pinned', operator: 'is', value: 'true' },
        ),
      ),
    ).toBe('Priority is urgent or Pinned');
    expect(
      describeQuery(q('all', { field: 'muted', operator: 'is', value: 'false' })),
    ).toBe('not Muted');
  });
});
