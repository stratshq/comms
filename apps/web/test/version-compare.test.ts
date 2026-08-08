import { describe, it, expect } from 'vitest';
import { isUpToDate, normalizeTag } from '../src/lib/version-compare';

describe('isUpToDate', () => {
  it('compares semver with and without the v prefix', () => {
    expect(isUpToDate('0.1.0', 'v0.1.0')).toBe(true);
    expect(isUpToDate('v0.2.0', '0.1.9')).toBe(true);
    expect(isUpToDate('0.1.0', '0.2.0')).toBe(false);
    expect(isUpToDate('1.0.0', '0.99.99')).toBe(true);
  });

  it('treats missing segments as zero', () => {
    expect(isUpToDate('1.2', '1.2.0')).toBe(true);
    expect(isUpToDate('1.2', '1.2.1')).toBe(false);
  });

  it('answers null rather than guessing on non-numeric tags', () => {
    expect(isUpToDate('0.1.0', 'beta')).toBeNull();
    expect(isUpToDate('nightly', 'nightly')).toBe(true);
  });
});

describe('normalizeTag', () => {
  it('strips the v prefix and whitespace only', () => {
    expect(normalizeTag(' v1.2.3 ')).toBe('1.2.3');
    expect(normalizeTag('1.2.3')).toBe('1.2.3');
  });
});
