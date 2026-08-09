# Comms Roadmap

This roadmap turns the "cracked-engineer" vision into a sequenced program. Wave 0
(the foundation) is already in `main`/the dev branch: monorepo, schema, BlueBubbles
bridge, worker pipelines, auth, inbox + ticketing UI, Railway deploy.

Status legend: ✅ done · 🚧 in progress · ⬜ planned

---

## Tier 1 — Make it real (engineering & ops) 🚧

Turning breadth into something trustworthy — this cuts across all waves.

- ✅ Vitest unit suite for correctness-critical primitives (credential crypto,
  handle normalization, reaction mapping, temp-guid)
- ✅ One-command local stack (`docker compose up`) — Postgres + Redis + MinIO + web + worker
- ✅ Boot smoke test (`scripts/smoke-test.sh`)
- ✅ GitHub Actions CI (build + typecheck + test + Docker image build)
- ⬜ Integration tests for the ingest pipeline (echo reconciliation, automations, SLA) against a Postgres service
- ⬜ Playwright end-to-end (setup wizard → connect → reply)
- ⬜ Observability: connection health / queue depth / send-failure dashboard

---

## Wave 1 — AI-native + reliable (in progress)

The two headline bets: make Comms AI-native, and make the iMessage bridge
trustworthy. Both are mostly backend and shippable without new infra.

- 🚧 **AI layer (`packages/ai`)** — multi-provider: connect Anthropic, OpenAI,
  Google, xAI or any OpenAI-compatible endpoint from the admin panel
  (encrypted keys, test button); `ANTHROPIC_API_KEY` remains the zero-config
  fallback
  - 🚧 Conversation summarization ("catch me up")
  - 🚧 Suggested reply / draft in brand voice (RAG over past resolved replies)
  - 🚧 Auto-triage on new conversations: priority, topic, sentiment, suggested tags
  - ⬜ Eval harness: golden conversations + automated scoring + regression gates
  - ⬜ Smart compose / inline autocomplete
  - ✅ Bundles — AI groups similar active threads into named sections in the list
  - ✅ Nudges — broken outbound promises ("I'll send it Friday") detected from
    your own words and resurfaced when overdue
  - ⬜ Auto-resolve tier-1 with confidence threshold + human handoff
  - ⬜ Real-time translation (inbound + outbound)
  - ⬜ Voice-memo transcription + image understanding
- 🚧 **Reliability / deliverability**
  - 🚧 Adaptive send pacing (per-number token bucket to avoid Apple throttling)
  - 🚧 Self-healing ingestion (periodic reconcile/backfill to fill missed-webhook gaps)
  - ⬜ Transport failover (Socket.IO when webhooks unreachable; auto re-register on URL change)
  - ⬜ Per-recipient backoff + deliverability monitoring/alerts
  - ⬜ Liveness alerting when the Mac sleeps / tunnel rotates

## Wave 2 — Multi-agent collaboration ✅ (core)

What makes Comms enterprise rather than a personal bridge.

- ✅ Real-time presence ("Sarah is viewing / typing…") + collision warnings
- ✅ @mentions in internal notes with notifications (+ notification bell)
- ✅ Assignment rules engine (round-robin + least-busy auto-assignment)
- ✅ **Roles & permissions** — replaced Teams. Customizable roles with
  per-permission grants (users, roles, workspace, inboxes, automations,
  shared folders, system admin); built-in Owner/Admin/Agent, custom roles,
  owner-safety invariants. Routing-by-team was removed in its favour
- ✅ Shared drafts — write a reply, share it for review, a teammate approves &
  sends it (with "drafted by" attribution)
- ⬜ Skills-based / business-hours routing; escalation / handoff with context

## Wave 3 — Workflow & ticketing depth ✅ (core)

- ✅ SLA timers + breach alerts (response-due clock, breach sweep, assignee notify)
- ✅ CSAT surveys delivered over iMessage after resolution (1–5 capture)
- ✅ Automations engine: triggers (new conversation / inbound) → keyword
  conditions → actions (status/priority/assign/tags), with a no-code rule builder
- ✅ Bulk actions (multi-select close/reopen in the conversation list)
- ✅ Pause-on-pending SLA (clock pauses when not actively open)
- ✅ **Folders** — a named filter with a place to live: a sidebar row or a
  section inside the inbox list (the split inbox). Membership is computed, so a
  new folder already contains its history and threads leave when they stop
  matching
- ✅ Split inbox by correspondent — People / Unknown / Automated / Verification
  codes, classified from traffic at ingest, with a copy-the-code chip on OTP rows.
  Shipped ON by default (seeded shared folders, toggleable in Settings → Workspace)
- ✅ **Admin panel** (Settings → Other) — version + update check, administrators
  and recent users, AI provider management, runtime-tunable config (undo window,
  send caps — no redeploy), and a Health tab: Postgres/Redis latency, queue
  depths, worker heartbeat, bridge status
- ✅ Automations can route to a team, mute a thread, and condition on the
  correspondent kind
- ⬜ Merge/split/link conversations; cross-handle entity resolution
- ⬜ Full business-hours-aware SLA windows

## Wave 4 — Performance & UX excellence 🚧

- ✅ Command palette (⌘K) + keyboard navigation (search + jump-to)
- ✅ Full-text search across all messages, contacts, and conversation titles
- ✅ Focus & Reply mode — one conversation full screen, progress counter, send/close advances the stack
- ✅ Split-view details pane (Details / Files / Schedule tabs) with per-thread attachment & link gallery
- ✅ Undo on every action (close, snooze, assign, priority, mute, bulk, bundles) with one consistent toast
- ✅ Mute — permanently silence a thread (group chats) without archiving it
- ✅ Signatures — personal + per-inbox, with a workspace-level switch
- ✅ Instant Intro — region, local time, history and self-introduction extraction for unknown numbers
- ✅ Offer times — business-hours availability inserted into a reply as text
- ⬜ Semantic search (pgvector embeddings, kept fresh by the worker)
- ⬜ Linear-style local sync engine (IndexedDB store + optimistic mutations + delta sync)
- ⬜ Native mobile app (reply on the go)
- ⬜ Rich iMessage parity from the UI: tapbacks, typing, edit/unsend, effects, scheduled send

## Wave 5 — Platform & extensibility

- ⬜ Channel driver abstraction (WhatsApp, SMS/Twilio, Instagram, Telegram, email)
- ⬜ Sidebar apps framework (Stripe/Shopify/CRM in the contact panel)
- ⬜ Public API + outbound webhooks + CLI; reply-from-Slack
- ⬜ Marketplace for macros / automations / apps

## Wave 6 — Trust, security, compliance (enterprise)

- ✅ Granular RBAC (customizable roles + permission catalog)
- ⬜ SSO/SAML/SCIM, approval workflows
- ⬜ PII redaction, data-retention policies, GDPR delete
- ⬜ On-prem / air-gapped story; per-agent permissions

## The unfair advantage

Combine Wave 1 (AI autopilot + reliable ingestion) into: **an open-source,
self-hostable, AI-native iMessage support desk that resolves real tier-1 volume
and never drops a message.** No competitor can say that sentence today.
