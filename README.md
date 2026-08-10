<div align="center">

# Comms

**An open-source, self-hostable team inbox + ticketing platform for iMessage — and beyond.**

Think Beeper for enterprise, with a help desk built in. Share an iMessage number across your team,
assign conversations as tickets, use macros, and reply together — all from a clean, fast UI you host
yourself.

![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-black)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-black)
![Self-hostable](https://img.shields.io/badge/self--hostable-Railway-black)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-black)

</div>

---

## What is Comms?

Comms turns a shared iMessage number into a collaborative support inbox. It connects to
[BlueBubbles](https://bluebubbles.app) (the open-source iMessage bridge you run on a Mac) and layers a
real ticketing workflow on top: assignment, statuses, priorities, internal notes, tags, and macros.

iMessage is the first channel. The architecture is channel-agnostic, with WhatsApp and others planned.

### Features

- 📨 **Shared inbox** — every iMessage conversation in one place, in real time (SSE-powered live updates)
- 🎫 **Ticketing** — status (open / pending / snoozed / closed), priority, assignment to people, tags
- 📝 **Internal notes** — discuss a conversation privately without messaging the customer
- ⚡ **Macros** — one-click canned responses
- 👥 **Multi-agent safe** — per-conversation send serialization + echo reconciliation so two agents
  on one number never collide
- 🔌 **BlueBubbles bridge** — auto webhook registration, Private API feature detection, history backfill
- 🔐 **Flexible auth** — local email + password (zero config), magic-link email, and Google/GitHub SSO
- 🎨 **Clean, enterprise UI** — black & white, shadcn/ui + Framer Motion
- 🚀 **One-click Railway deploy** — almost zero environment variables to set

## Deploy to Railway (step by step)

You'll create **one Railway project with four services** — Postgres, Redis, a **web**
service, and a **worker** service — all from this one repo. It takes about 10 minutes,
and you **don't type a single value yourself**.

> **The whole config in one glance — just 2 variables, the same on both the web and worker services:**
>
> ```bash
> DATABASE_URL=${{ Postgres.DATABASE_URL }}
> REDIS_URL=${{ Redis.REDIS_URL }}
> ```
>
> Both are one-click *references*, not values you invent. Everything else is automatic:
> Comms generates and stores its own app secret on first boot, derives its public URL,
> and runs database migrations for you. Email, AI, file attachments, and OAuth are
> **optional** and added later from inside the app or as extra variables — never required
> to get started.

### Before you begin

You'll need:

- A free [Railway](https://railway.com) account (sign in with GitHub).
- A **fork** of this repo on your own GitHub account (click **Fork** at the top of this page).
- A Mac signed into iMessage running [BlueBubbles](https://bluebubbles.app) — this is what
  connects Comms to iMessage. You can set this up after deploying (see
  [How the iMessage bridge works](#how-the-imessage-bridge-works)).

Nothing to install on your own computer — the whole app runs on Railway.

### 1. Create the project from this repo

- Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pick your fork of `comms`.
- Railway creates one service from the repo. We'll make this the **web** service in step 4.

### 2. Add Postgres

- In the project, click **New** → **Database** → **Add PostgreSQL**. Leave it named **`Postgres`**.

### 3. Add Redis

- Click **New** → **Database** → **Add Redis**. Leave it named **`Redis`**.

> Keep the default names `Postgres` and `Redis` — the variable references below use them. If you rename a database, update the references to match.

### 4. Configure the web service

Open the repo service from step 1, then:

**a. Point it at the web config.** Settings → **Config-as-code / Railway Config File** → set the path to:

```
apps/web/railway.json
```

This tells Railway to build the Docker image, run database migrations automatically before each deploy, start the web server, and health-check `/api/health`.

**b. Set the web service variables.** On the web service → **Variables** → **Raw Editor** → paste exactly:

```bash
DATABASE_URL=${{ Postgres.DATABASE_URL }}
REDIS_URL=${{ Redis.REDIS_URL }}
```

**c. Give it a public URL.** Settings → **Networking** → **Generate Domain**.

### 5. Add the worker service

- Click **New** → **GitHub Repo** → pick the **same** `comms` repo again.
- Settings → **Config File** → set the path to:

```
apps/worker/railway.json
```

- **Variables** → **Raw Editor** → paste the **same two lines** as the web service:

```bash
DATABASE_URL=${{ Postgres.DATABASE_URL }}
REDIS_URL=${{ Redis.REDIS_URL }}
```

- The worker has **no public port** — do **not** generate a domain for it.

### 6. Deploy & finish setup

- Railway builds and deploys all four services. The web service runs migrations automatically on its first deploy.
- Open the web service's domain (e.g. `https://your-app.up.railway.app`). You'll see the **first-run setup wizard** — create your admin account.
- Go to **Settings → Inboxes → Connect BlueBubbles** and paste your BlueBubbles server URL + password (see the next section).

That's it — you're live. 🎉

### The minimal variables, explained

| Variable | Required? | What to set | Why |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ Yes | `${{ Postgres.DATABASE_URL }}` | Connects to Postgres. A reference — no value to type. |
| `REDIS_URL` | ✅ Yes | `${{ Redis.REDIS_URL }}` | Queues + realtime. A reference — no value to type. |
| *(app secret)* | ⚙️ Auto | — | Generated and stored in the database on first boot. Nothing to set. |
| *(public URL)* | ⚙️ Auto | — | Derived from Railway's generated domain. Nothing to set. |
| `APP_SECRET` | ⬜ Optional | `${{ secret(48) }}` (a **shared** variable) | Override the auto-generated secret. Recommended for production hardening — keeps the encryption key out of the database. If you set it, set it on **both** services with the same value. |
| `ANTHROPIC_API_KEY` | ⬜ Optional | your Claude API key | Enables AI summaries, draft replies, and auto-triage. |
| `S3_*` | ⬜ Optional | from a Storage Bucket / S3 | Enables file attachments (see below). |
| `SMTP_*` | ⬜ Optional | your mail provider | Enables magic-link sign-in, invites, notifications. |
| `GOOGLE_*` / `GITHUB_*` | ⬜ Optional | OAuth app creds | Enables Google / GitHub sign-in. |

See [`.env.example`](./.env.example) for the full list with descriptions.

### Optional: file attachments

Attachments need S3-compatible storage. The easiest on Railway is a native **Storage Bucket**
(**New → Storage Bucket**). Then add these to **both** the web and worker services, mapping the
bucket's variables:

```bash
S3_ENDPOINT=${{ Bucket.ENDPOINT }}
S3_BUCKET=${{ Bucket.BUCKET_NAME }}
S3_ACCESS_KEY_ID=${{ Bucket.ACCESS_KEY_ID }}
S3_SECRET_ACCESS_KEY=${{ Bucket.SECRET_ACCESS_KEY }}
S3_REGION=auto
```

(Exact variable names depend on the bucket plugin — open the bucket's **Variables** tab to confirm. Any S3-compatible store works too: Cloudflare R2, Backblaze B2, AWS S3.)

### Troubleshooting

- **Web crashes on boot with a DB/Redis error** → the variable references didn't resolve. Confirm `Postgres` and `Redis` are the exact service names, and that the three variables are set on the service.
- **Webhook didn't register when connecting BlueBubbles** → your app needs a public URL BlueBubbles can reach. Make sure you generated a domain (step 4d); then in **Settings → Inboxes** click **Re-register webhook**.
- **Messages don't arrive / send** → check the **worker** service logs; it must be running with the same three variables as web.

## How the iMessage bridge works

```
 iPhone/Mac  ⇄  iMessage  ⇄  BlueBubbles server (your Mac)  ⇄  Comms (web + worker)  ⇄  your team
```

1. You run [BlueBubbles](https://docs.bluebubbles.app) on a Mac signed into iMessage and expose it
   (Cloudflare Tunnel, ngrok, or your own domain).
2. In Comms, go to **Settings → Inboxes → Connect BlueBubbles** and paste the server URL + password.
   Comms verifies the connection, detects whether the Private API is available (reactions, typing,
   edits), registers an inbound webhook, and backfills recent history.
3. Inbound messages flow in via webhook → worker → your shared inbox. Replies are queued and sent
   through a per-conversation lock so multiple agents stay in sync.

For the richest feature set (reactions, typing indicators, edit/unsend, read receipts), enable the
BlueBubbles **Private API** on the Mac. Comms automatically falls back to basic mode if it isn't
available.

## Architecture

A pnpm monorepo, one Docker image, two runtime roles:

```
apps/
  web/        Next.js 15 (App Router) — UI, API routes, server actions, auth
  worker/     BullMQ worker — inbound ingestion, outbound sends, attachments, backfill, heartbeats
  www/        Marketing site — deploys separately, depends on no workspace package
packages/
  db/         Drizzle ORM schema + migrations + client (Postgres)
  core/       Shared libs — config, crypto, Redis/queues, S3 storage, realtime, BlueBubbles client
  ai/         Claude-powered features (summarize, suggest reply, triage)
  enterprise/ Paid edition — separately licensed, never required to run Comms
```

- **Database:** Postgres via Drizzle ORM
- **Queues + realtime:** Redis (BullMQ for jobs, pub/sub for live UI updates over SSE)
- **Storage:** any S3-compatible store (Railway Storage Bucket, Cloudflare R2, MinIO, AWS S3)
- **Auth:** Auth.js (NextAuth v5) — credentials + magic-link + OAuth
- **UI:** Tailwind CSS + shadcn/ui + Framer Motion

## Local development

The fastest way — the whole stack (Postgres + Redis + MinIO + web + worker) in one command:

```bash
docker compose up --build       # then open http://localhost:3000
```

Or run it with pnpm. Prerequisites: Node 22+, pnpm 10+, and a local Postgres + Redis.

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL and REDIS_URL (that's all)

pnpm --filter @comms/db build   # build the db package
pnpm db:generate                # generate the SQL migration from the schema
pnpm db:migrate                 # apply migrations

pnpm dev                        # runs web (http://localhost:3000) + worker
```

Open http://localhost:3000 and complete the setup wizard to create your admin account.

### Useful scripts

| Command | Description |
| --- | --- |
| `pnpm build` | Build all packages and apps |
| `pnpm dev` | Run web + worker in watch mode |
| `pnpm db:generate` | Generate a Drizzle migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm typecheck` | Type-check the whole repo |
| `pnpm test` | Run the unit test suite (Vitest) |
| `./scripts/smoke-test.sh` | Boot the full Docker stack and verify it comes up healthy |

## Roadmap

- [ ] Outbound attachments & reactions from the UI
- [ ] Command palette + keyboard shortcuts
- [ ] SLA timers & reporting
- [ ] WhatsApp and additional channels
- [ ] Saved views & advanced search
- [ ] Multi-tenant (hosted) mode

## License

Comms is **AGPLv3** — see [LICENSE](./LICENSE).

In practice, for almost everyone: run it for your team, free, forever, including
commercially, with no seat limit and no license key. Fork it, modify it, deploy it
anywhere. The one obligation the AGPL adds over the GPL only applies if you modify
Comms *and* offer the modified version to other people over a network — then you owe
those users your changes. Running it unmodified, or keeping your changes internal to
your own company, requires nothing of you.

### The one exception

`packages/enterprise/` is **not** AGPLv3. It is source-available under the
[Comms Enterprise Edition License](./packages/enterprise/LICENSE): free to read,
modify, and run in development, but production use needs a subscription.

It contains three things, and nothing else:

| Feature | What it is |
| --- | --- |
| `billing` | Metered seats, plans, invoices, payment webhooks. Powers the hosted version. |
| `sso` | SAML 2.0 / OIDC against a corporate IdP, SCIM provisioning, domain auto-join. |
| `audit-log` | Retention windows and CSV / SIEM export over the audit trail. |

**Everything else stays free, permanently.** The shared inbox, ticketing, macros,
automations, RBAC, AI features and the BlueBubbles bridge are all AGPLv3. So are
email + password, magic links, and Google/GitHub sign-in — only *enterprise IdP* SSO
is paid. So is the `audit_logs` table and every write to it — only the retention and
export surface on top is paid.

Nothing in `packages/enterprise/` is required to run Comms, and the hosted version is
this same repository with billing switched on, not a private fork.

### Contributing

Contributions are accepted under the terms in [CONTRIBUTING.md](./CONTRIBUTING.md),
which include a license grant allowing the project to distribute contributions under
both licenses. You keep the copyright in your own work. Sign off your commits with
`git commit -s`.
