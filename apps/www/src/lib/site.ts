/**
 * Every externally-visible string the site depends on, in one place.
 *
 * The marketing site and the app get deployed on different days by different
 * pipelines, so anything shared between them is copied here deliberately rather
 * than imported. One file to edit when the domain or the repo moves.
 */
export const site = {
  name: 'Comms',
  tagline: 'A shared team inbox for iMessage, with a help desk built in.',
  description:
    'Share an iMessage number across your team, assign conversations as tickets, use macros, and reply together. Open source and self-hostable, or fully managed.',
  /** Set NEXT_PUBLIC_SITE_URL at build time; the fallback keeps local dev working. */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001',
  github: 'https://github.com/stratshq/comms',
  docs: 'https://github.com/stratshq/comms#readme',
  license: 'https://github.com/stratshq/comms/blob/main/LICENSE',
} as const;

export const nav = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: site.docs },
  { label: 'GitHub', href: site.github },
] as const;
