/**
 * Sidebar sizing.
 *
 * The width is a preference, not a constant: folder and channel names are as
 * long as people's clients are, and 248px truncates "Verification codes" on
 * the one screen where you scan names. Kept in localStorage rather than the
 * database because it belongs to the screen you are sitting at — the same
 * account on a laptop and a 32" monitor wants two different answers.
 */

export const SIDEBAR_DEFAULT_WIDTH = 248;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 460;
export const SIDEBAR_WIDTH_KEY = 'comms:sidebar-width';

/** Keep a dragged or stored width inside the usable range. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** Parse a stored value, falling back to the default for anything unusable. */
export function readStoredWidth(raw: string | null): number {
  if (!raw) return SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(parsed);
}
