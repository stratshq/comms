# Contributing to Comms

Thanks for your interest in improving Comms! This is an open-source, self-hostable
team inbox + ticketing platform for iMessage (via BlueBubbles) and beyond.

## Project layout

```
apps/
  web/        Next.js 15 (App Router) — UI, API routes, server actions, auth
  worker/     BullMQ worker — inbound ingestion, outbound sends, attachments,
              backfill, heartbeats, automations, SLA, AI triage
  www/        Next.js marketing site — deploys on its own, no dependency on the app
packages/
  db/         Drizzle ORM schema + migrations + client (Postgres)
  core/       Shared libs — config, crypto, Redis/queues, S3, realtime, BlueBubbles client
  ai/         Claude-powered features (summarize, suggest reply, triage)
  enterprise/ Paid edition — NOT AGPLv3, see packages/enterprise/LICENSE
```

> **Heads up on `packages/enterprise/`.** Everything else in this repository is
> AGPLv3. That one directory is source-available under a separate commercial
> license. You can read it, modify it, and run it in development for free;
> production use needs a subscription. Contributions there are welcome on the same
> terms as everywhere else — see [License and contributions](#license-and-contributions).

## Getting started

### Fastest: run the whole stack in Docker

Boots Postgres + Redis + MinIO + web + worker with one command:

```bash
docker compose up --build      # then open http://localhost:3000
```

Verify a fresh build boots end-to-end (used in review):

```bash
./scripts/smoke-test.sh
```

### Or run it locally with pnpm

Prerequisites: Node 22+, pnpm 10+, and a local Postgres + Redis.

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL and REDIS_URL (that's all)

pnpm --filter @comms/db build
pnpm db:generate                # only if you changed the schema
pnpm db:migrate
pnpm dev                        # web on :3000 + worker
```

## Before you open a PR

CI runs all of these on every PR — run them locally first:

- `pnpm build` — the whole monorepo must build
- `pnpm typecheck` — must pass (strict TypeScript, `noUncheckedIndexedAccess`)
- `pnpm test` — unit tests must pass
- `pnpm format` — Prettier
- If you changed `packages/db/src/schema`, run `pnpm db:generate` and commit the
  generated migration in `packages/db/migrations`.

## Conventions

- TypeScript everywhere; keep server-only code out of client components.
- Match the surrounding style — small, focused commits with clear messages.
- The roadmap lives in [`ROADMAP.md`](./ROADMAP.md); features are grouped into waves.

## Security

Found a vulnerability? Please open a private report rather than a public issue.
Never commit secrets — integration credentials are encrypted at rest and should
only ever be provided via environment variables or the in-app settings.

## License and contributions

Comms is licensed under the [GNU AGPLv3](./LICENSE), except for
`packages/enterprise/`, which is under the
[Comms Enterprise Edition License](./packages/enterprise/LICENSE).

Because the project is distributed under two licenses, it needs contributors to
grant slightly more than "inbound = outbound". The grant below is what makes that
legal. It is deliberately short, and it is the whole agreement — there is no
separate document to sign and no account to create.

### Contributor terms

By submitting a contribution (a pull request, a patch, or a suggested change
applied from a review comment), you agree to the following.

1. **You keep your copyright.** You are not assigning it. You are granting
   licenses, and you remain free to use your own contribution anywhere else, for
   anything, forever.

2. **You have the right to submit it.** The work is yours, or you have permission
   to submit it under these terms. If your employer has rights to work you produce,
   you have their permission. If any part is someone else's, you have said so in the
   pull request and identified its license.

3. **You license it under the AGPLv3**, on the same terms as the rest of the
   project.

4. **You also grant the maintainers a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable license** to reproduce, modify, and distribute your
   contribution under the Comms Enterprise Edition License, or under other terms the
   maintainers choose for the project.

   This is the clause that lets the project stay dual-licensed. Without it, a single
   contribution to a shared file could make it impossible to ship the paid edition —
   and, in practice, impossible to fund the free one.

5. **You grant a patent license** covering any patent claims you own that your
   contribution necessarily infringes, on the same terms.

6. **No warranty.** You provide your contribution as-is, with no warranties of any
   kind.

Clause 4 runs to the maintainers, not to the public. It does not let anyone else
take your work proprietary, and it does not weaken the AGPLv3 obligations on the
open source portion — those continue to apply in full, to everyone, including us.

### Signing off

Add a `Signed-off-by` line to each commit, which records your agreement to the terms
above:

```bash
git commit -s -m "fix: reconcile echoes for group chats"
```

`-s` uses your configured `user.name` and `user.email`. Use a real name and a real
address.

If you would rather not agree to clause 4, that is completely reasonable — open an
issue describing the change instead of a pull request, and a maintainer can
implement it independently.
