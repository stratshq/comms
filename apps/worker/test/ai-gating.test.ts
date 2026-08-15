import { describe, it, expect } from 'vitest';
import {
  isTriageStale,
  modelMaySetPriority,
  shouldDraftReply,
  shouldTriage,
  type DraftGateInput,
} from '../src/lib/ai-gating.js';

/** A thread that qualifies for everything, so each test can spoil one thing. */
const REPLYABLE: DraftGateInput = {
  kind: 'person',
  status: 'open',
  mutedAt: null,
  lastDirection: 'inbound',
};

describe('shouldDraftReply', () => {
  it('drafts for a person who has just written to us', () => {
    expect(shouldDraftReply(REPLYABLE)).toBe(true);
    expect(shouldDraftReply({ ...REPLYABLE, kind: 'unknown' })).toBe(true);
    expect(shouldDraftReply({ ...REPLYABLE, status: 'pending' })).toBe(true);
    expect(shouldDraftReply({ ...REPLYABLE, status: 'snoozed' })).toBe(true);
  });

  it('never drafts a reply to machine traffic', () => {
    expect(shouldDraftReply({ ...REPLYABLE, kind: 'otp' })).toBe(false);
    expect(shouldDraftReply({ ...REPLYABLE, kind: 'automated' })).toBe(false);
  });

  it('skips threads nobody is going to answer', () => {
    expect(shouldDraftReply({ ...REPLYABLE, status: 'closed' })).toBe(false);
    expect(shouldDraftReply({ ...REPLYABLE, mutedAt: new Date() })).toBe(false);
  });

  it('skips when the last word was already ours, or there is none', () => {
    expect(shouldDraftReply({ ...REPLYABLE, lastDirection: 'outbound' })).toBe(false);
    expect(shouldDraftReply({ ...REPLYABLE, lastDirection: null })).toBe(false);
  });
});

describe('shouldTriage', () => {
  it('classifies people but not machines', () => {
    expect(shouldTriage('person')).toBe(true);
    expect(shouldTriage('unknown')).toBe(true);
    expect(shouldTriage('otp')).toBe(false);
    expect(shouldTriage('automated')).toBe(false);
  });
});

describe('isTriageStale', () => {
  const early = new Date('2026-08-14T10:00:00Z');
  const late = new Date('2026-08-14T11:00:00Z');

  it('is stale until the thread has ever been classified', () => {
    expect(isTriageStale({ triagedAt: null, lastInboundAt: early })).toBe(true);
    expect(isTriageStale({ triagedAt: null, lastInboundAt: null })).toBe(true);
  });

  it('is stale once something has arrived since the last run', () => {
    expect(isTriageStale({ triagedAt: early, lastInboundAt: late })).toBe(true);
  });

  it('is fresh when the last run already covered the newest message', () => {
    expect(isTriageStale({ triagedAt: late, lastInboundAt: early })).toBe(false);
    // A duplicate job from the same burst: same instant, nothing new.
    expect(isTriageStale({ triagedAt: early, lastInboundAt: early })).toBe(false);
  });

  it('is fresh for a thread that has never received anything', () => {
    expect(isTriageStale({ triagedAt: early, lastInboundAt: null })).toBe(false);
  });
});

describe('modelMaySetPriority', () => {
  it('may set a priority nobody has touched', () => {
    expect(modelMaySetPriority({ current: 'normal', modelChose: null })).toBe(true);
  });

  it('may revise its own earlier answer — including downwards', () => {
    // The whole point: without this, a thread the model called urgent could
    // never calm down again.
    expect(modelMaySetPriority({ current: 'urgent', modelChose: 'urgent' })).toBe(true);
  });

  it('defers permanently once a human disagrees', () => {
    expect(modelMaySetPriority({ current: 'low', modelChose: 'urgent' })).toBe(false);
    expect(modelMaySetPriority({ current: 'high', modelChose: null })).toBe(false);
  });
});
