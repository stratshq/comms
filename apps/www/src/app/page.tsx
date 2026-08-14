import Link from 'next/link';
import { site } from '@/lib/site';

const features = [
  {
    title: 'Shared inbox',
    body: 'Every iMessage conversation in one place, updating live. Two agents on one number never collide — sends are serialized per conversation and echoes reconciled.',
  },
  {
    title: 'Real ticketing',
    body: 'Status, priority, assignment, tags, and internal notes. Snooze a thread until Tuesday. Discuss it privately without messaging the customer.',
  },
  {
    title: 'Macros and automations',
    body: 'One-click canned responses, routing rules, business hours, and SLA timers. The repetitive half of support stops being typed by hand.',
  },
  {
    title: 'AI where it helps',
    body: 'Summarize a long thread, suggest a reply, triage on arrival. Bring your own Anthropic key, or leave it off entirely — nothing depends on it.',
  },
  {
    title: 'Runs on your Mac bridge',
    body: 'Connects to BlueBubbles, the open-source iMessage bridge. Auto webhook registration, Private API feature detection, and history backfill.',
  },
  {
    title: 'Yours to host',
    body: 'One repo, four services, about ten minutes on Railway. Two environment variables, both one-click references. No vendor in the message path.',
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="container pb-16 pt-20 sm:pb-24 sm:pt-28">
        <div className="max-w-3xl">
          <p className="border-border bg-surface-sunken text-muted-foreground mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
            <span className="bg-success inline-block h-1.5 w-1.5 rounded-full" />
            Open source · AGPLv3 · self-hostable
          </p>

          <h1 className="text-4xl leading-[1.05] sm:text-6xl">
            A shared team inbox for iMessage, with a help desk built in.
          </h1>

          <p className="text-muted-foreground mt-6 max-w-prose text-lg leading-relaxed">
            Share one iMessage number across your team. Assign conversations as tickets, reply
            together, and keep the whole history in a system you own. Think Beeper for enterprise —
            except you can read every line of it.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href={site.github}
              target="_blank"
              rel="noreferrer"
              className="bg-primary text-primary-foreground inline-flex h-11 items-center rounded-lg px-5 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Self-host it free
            </a>
            <Link
              href="/pricing"
              className="border-border-strong hover:bg-surface-sunken inline-flex h-11 items-center rounded-lg border px-5 text-sm font-medium transition-colors"
            >
              See pricing
            </Link>
          </div>

          <p className="text-muted-foreground mt-4 text-sm">
            No seat limit, no license key, no trial clock. The free version is the whole product.
          </p>
        </div>
      </section>

      <section className="container pb-8">
        <div className="border-border bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="bg-surface p-6">
              <h3 className="text-[15px]">{f.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container py-20">
        <div className="max-w-prose">
          <h2 className="text-2xl sm:text-3xl">Why iMessage, and why self-hosted</h2>
          <div className="text-muted-foreground mt-5 space-y-4 leading-relaxed">
            <p>
              Customers text. They do not open a portal, and increasingly they do not open email.
              But the moment a number is shared by more than one person, a phone stops being enough:
              two people answer the same thread, nobody knows what was promised, and the history
              lives on one laptop.
            </p>
            <p>
              Comms puts a real support workflow on top of that number without moving the
              conversation somewhere your customer has to learn. And because the whole thing runs on
              your infrastructure, the messages your business depends on are not sitting in a vendor
              you cannot audit or migrate off.
            </p>
            <p>
              iMessage is the first channel. The architecture is channel-agnostic — WhatsApp and
              others are on the roadmap.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
