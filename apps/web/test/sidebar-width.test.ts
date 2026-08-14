import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readStoredWidth,
} from '../src/lib/sidebar-width';

describe('clampSidebarWidth', () => {
  it('keeps a sensible width untouched, rounded', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('clamps past either end rather than letting the pane vanish', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('readStoredWidth', () => {
  it('reads a stored number', () => {
    expect(readStoredWidth('320')).toBe(320);
  });

  it('defaults on anything unusable — a corrupt key must not break the shell', () => {
    expect(readStoredWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readStoredWidth('')).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readStoredWidth('wide please')).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('clamps a stored value that is out of range', () => {
    expect(readStoredWidth('5000')).toBe(SIDEBAR_MAX_WIDTH);
    expect(readStoredWidth('10')).toBe(SIDEBAR_MIN_WIDTH);
  });
});
