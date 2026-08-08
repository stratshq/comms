/**
 * Version comparison for the admin panel's "up to date?" line.
 *
 * Accepts "v1.2.3" and "1.2.3" interchangeably. Non-numeric tags can't be
 * ordered honestly, so they compare only by equality and otherwise answer
 * null — an "update available" badge based on a guess is worse than no badge.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

/** True = current >= latest; false = behind; null = can't tell. */
export function isUpToDate(current: string, latest: string): boolean | null {
  const a = normalizeTag(current).split('.').map(Number);
  const b = normalizeTag(latest).split('.').map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN) || a.length === 0 || b.length === 0) {
    return normalizeTag(current) === normalizeTag(latest) ? true : null;
  }
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}
