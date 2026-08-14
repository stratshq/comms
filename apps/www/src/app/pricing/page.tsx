import type { Metadata } from 'next';
import { site } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Self-host Comms free forever under the AGPLv3, or let us run it. Enterprise adds SSO, audit retention and billing.',
};

/**
 * The tiers mirror the licensing structure exactly: everything in the "Free"
 * column is AGPLv3 in the repository, and every "Enterprise" line maps to a
 * feature key in packages/enterprise/src/features.ts. If the two ever disagree,
 * this page is the one that is wrong.
 */
const tiers = [
  {
    name: 'Self-hosted',
    price: 'Free',
    cadence: 'forever',
    summary: 'The whole product, on your own infrastructure. No seat limit and no license key.',
    cta: { label: 'Deploy it yourself', href: site.github, external: true },
    highlight: false,
    features: [
      'Unlimited seats, conversations and history',
      'Shared inbox, ticketing, macros, automations, SLA',
      'Internal notes, tags, folders, saved views',
      'Role-based access control',
      'Email + password, magic links, Google and GitHub sign-in',
      'Audit trail of sensitive actions',
      'AI summaries, suggested replies and triage (your API key)',
      'Community support on GitHub',
    ],
  },
  {
    name: 'Cloud',
    price: '$12',
    cadence: 'per user / month',
    summary: 'The same build, run by us. For teams who would rather not operate Postgres.',
    cta: { label: 'Start a trial', href: '/pricing#cloud', external: false },
    highlight: true,
    features: [
      'Everything in Self-hosted',
      'Managed Postgres, Redis and object storage',
      'Automatic updates, backups and monitoring',
      'Email delivery and AI features included — no keys to supply',
      'Email support, next business day',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'annual',
    summary: 'For teams with a procurement process. Available on Cloud or self-hosted.',
    cta: { label: 'Talk to us', href: '/pricing#enterprise', external: false },
    highlight: false,
    features: [
      'Everything in Cloud',
      'SAML 2.0 / OIDC against your identity provider',
      'SCIM provisioning and domain-verified auto-join',
      'Audit log retention windows and CSV / SIEM export',
      'Self-hosted license key — verified offline, no phone home',
      'Priority support and an SLA',
    ],
  },
] as const;

const faqs = [
  {
    q: 'Is the free version crippled?',
    a: 'No. The shared inbox, ticketing, macros, automations, AI features and the BlueBubbles bridge are all AGPLv3, with no seat limit and no key. What is paid for is billing, enterprise identity, and compliance tooling — the things a company with a procurement process needs and a self-hoster never touches.',
  },
  {
    q: 'What does AGPLv3 mean for me?',
    a: 'If you run Comms for your own team — even commercially, even at scale — it means nothing you need to act on. The obligation only bites if you modify Comms and offer the modified version to other people over a network: then you owe those users your changes. Running it unmodified, or keeping your changes to yourself internally, is fine.',
  },
  {
    q: 'Can I run Comms as a service for my own customers?',
    a: 'Yes. The AGPLv3 permits commercial hosting. You would need to publish your modifications to the users of that service, and you could not use anything under packages/enterprise/ without a subscription.',
  },
  {
    q: 'Is Cloud a different codebase?',
    a: 'No. Cloud is this repository with billing switched on. That is deliberate: a fork we maintain privately would drift, and the self-hosted build would quietly become the worse one.',
  },
  {
    q: 'What happens if my subscription lapses?',
    a: 'Enterprise features keep working for a 14-day grace period, then switch off. Nothing else changes — the inbox keeps serving messages, your data stays yours, and an expired key never takes the app down. Self-hosted installs verify the key offline, so an outage on our side cannot lock you out.',
  },
] as const;

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="text-foreground mt-[3px] h-3.5 w-3.5 shrink-0"
    >
      <path
        d="M3 8.5l3.2 3.2L13 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function PricingPage() {
  return (
    <>
      <section className="container pb-12 pt-16 sm:pt-24">
        <div className="max-w-2xl">
          <h1 className="text-4xl sm:text-5xl">Pricing</h1>
          <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
            Self-host the whole product free, forever. Pay us only if you would rather not run it
            yourself, or if you need the enterprise identity and compliance pieces.
          </p>
        </div>
      </section>

      <section className="container pb-6">
        <div className="grid gap-6 lg:grid-cols-3">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`bg-surface flex flex-col rounded-lg border p-7 ${
                tier.highlight ? 'border-border-strong shadow-sm' : 'border-border'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg">{tier.name}</h2>
                {tier.highlight && (
                  <span className="border-border text-muted-foreground rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
                    Most popular
                  </span>
                )}
              </div>

              <div className="mt-5 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-tight">{tier.price}</span>
                <span className="text-muted-foreground text-sm">{tier.cadence}</span>
              </div>

              <p className="text-muted-foreground mt-4 min-h-[3.5rem] text-sm leading-relaxed">
                {tier.summary}
              </p>

              {tier.cta.external ? (
                <a
                  href={tier.cta.href}
                  target="_blank"
                  rel="noreferrer"
                  className={`mt-6 inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-medium transition-colors ${
                    tier.highlight
                      ? 'bg-primary text-primary-foreground hover:opacity-90'
                      : 'border-border-strong hover:bg-surface-sunken border'
                  }`}
                >
                  {tier.cta.label}
                </a>
              ) : (
                <a
                  href={tier.cta.href}
                  className={`mt-6 inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-medium transition-colors ${
                    tier.highlight
                      ? 'bg-primary text-primary-foreground hover:opacity-90'
                      : 'border-border-strong hover:bg-surface-sunken border'
                  }`}
                >
                  {tier.cta.label}
                </a>
              )}

              <ul className="mt-7 space-y-2.5 text-sm">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2.5 leading-relaxed">
                    <Check />
                    <span className="text-muted-foreground">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="container py-20">
        <h2 className="text-2xl sm:text-3xl">Questions people actually ask</h2>
        <dl className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {faqs.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.a}</dd>
            </div>
          ))}
        </dl>

        <p className="text-muted-foreground mt-12 max-w-prose text-sm leading-relaxed">
          The exact terms are in the repository, not in a sales deck: the{' '}
          <a
            href={site.license}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground underline underline-offset-4"
          >
            AGPLv3 and its exceptions
          </a>{' '}
          at the root, and the{' '}
          <a
            href={`${site.github}/blob/main/packages/enterprise/LICENSE`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground underline underline-offset-4"
          >
            Enterprise Edition license
          </a>{' '}
          alongside the code it covers.
        </p>
      </section>
    </>
  );
}
