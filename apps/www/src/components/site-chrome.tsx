import Link from 'next/link';
import { site, nav } from '@/lib/site';

/** True for anything we should not route through the client-side router. */
function isExternal(href: string): boolean {
  return href.startsWith('http');
}

export function SiteHeader() {
  return (
    <header className="border-border bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="text-[15px] font-semibold tracking-tight">
          {site.name}
        </Link>

        <nav className="flex items-center gap-1">
          {nav.map((item) =>
            isExternal(item.href) ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors"
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors"
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-border mt-24 border-t">
      <div className="text-muted-foreground container flex flex-col gap-4 py-10 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getFullYear()} {site.name}. Open source under{' '}
          <a
            href={site.license}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground underline underline-offset-4"
          >
            AGPLv3
          </a>
          .
        </p>
        <div className="flex gap-5">
          <a href={site.github} target="_blank" rel="noreferrer" className="hover:text-foreground">
            GitHub
          </a>
          <Link href="/pricing" className="hover:text-foreground">
            Pricing
          </Link>
        </div>
      </div>
    </footer>
  );
}
