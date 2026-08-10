# @comms/enterprise

**This directory is not open source.** The AGPLv3 in the repository root does not
apply here. See [`LICENSE`](./LICENSE).

You may read, audit, modify, and run this code in development and testing for
free, forever. Running it in production requires a Comms Enterprise
subscription.

---

## Why this exists

Comms is AGPLv3 so that anyone can self-host the whole product for free, and so
that a competitor cannot take it, host it as a service, and keep their changes
private. That covers almost everyone.

It does not cover the three things companies with a procurement process ask for,
which cost real money to build and maintain and which a hobbyist self-hoster
will never use. Those live here:

| Feature key | What it is                                                                       |
| ----------- | -------------------------------------------------------------------------------- |
| `billing`   | Metered seats, plans, invoices, payment-processor webhooks. Powers Comms Cloud.  |
| `sso`       | SAML 2.0 / OIDC against a customer IdP, SCIM provisioning, domain-verified join. |
| `audit-log` | Retention windows, filtered search, CSV / JSONL export over the audit trail.     |

### What stays free, permanently

The line is drawn deliberately, and it is not "the useful half":

- The **shared inbox, ticketing, macros, automations, AI features, and the
  BlueBubbles bridge** are AGPLv3. All of them. No seat limit, no key.
- **Google and GitHub sign-in, email + password, and magic links** are AGPLv3.
  Only _enterprise IdP_ SSO is paid.
- The **`audit_logs` table and every write to it** are AGPLv3. An inbox that
  stops recording who closed a ticket is a worse product, not a cheaper one.
  Only the retention/export surface on top is paid.

Nothing here is required to run Comms. Import this package with no license key
and every gate returns `false`; the app runs as the community edition.

---

## Using the gate

Check before doing paid work, and always keep a community-edition path:

```ts
import { hasFeature, requireFeature } from '@comms/enterprise';

if (hasFeature('audit-log')) {
  return renderRetentionSettings();
}
return renderUpgradePrompt();
```

`requireFeature` throws `EnterpriseFeatureRequiredError` and belongs at the entry
point of an Enterprise path — a server action or a job handler — not deep inside
one.

`loadEnterprise()` returns the full status (edition, seats, expiry, grace state)
for the admin panel. It reads the environment once and caches; call
`_resetEnterpriseCache()` if a key changes at runtime.

---

## How licensing works

A license key is an Ed25519 signature over a JSON claims blob:

```
comms_<base64url(claims)>.<base64url(signature)>
```

Verification is **offline**. The public key is baked into the build, so a
self-hosted install never phones home, keeps working when our servers are down,
and works behind an air gap. The tradeoff is no revocation before expiry, which
is handled by issuing short-dated keys and reissuing on renewal — not by adding
a callback.

Three properties worth knowing:

- **A bad key never takes the app down.** Malformed, expired, or wrongly signed
  keys degrade to community edition with `status.problem` set for the admin
  panel. The inbox keeps serving messages.
- **There is a 14-day grace period** after expiry (`LICENSE_GRACE_DAYS`). A
  failed renewal should page someone, not take a support desk offline mid-shift.
- **Seat overage is reported, not enforced.** `seatStatus()` returns the
  overage; the UI shows a banner. Locking people out of a support queue over a
  late invoice is worse for the customer than a banner is for us.

### Issuing keys

Generate the keypair once, ever:

```bash
node packages/enterprise/scripts/issue-license.mjs keygen
```

Paste the public half into `BUILTIN_LICENSE_PUBLIC_KEY` in `src/gate.ts`. Keep
the private half in a secret manager — anyone holding it can mint licenses for
every build that trusts the matching public key. It is empty in the open source
tree on purpose: there is no shared secret to leak, and a fork should sign with
its own key rather than inherit ours.

Then, per customer:

```bash
COMMS_LICENSE_PRIVATE_KEY=<private> \
  node packages/enterprise/scripts/issue-license.mjs sign \
  --sub "Acme Inc" --seats 25 --days 365
```

`--features` defaults to `*` (everything, including features added in later
releases). Pass a comma-separated list to scope it. `--seats 0` is unlimited and
`--days 0` is perpetual.

The operator sets the result as `COMMS_LICENSE_KEY`. To verify against a key
other than the built-in one — a fork, or a staging issuer — set
`COMMS_LICENSE_PUBLIC_KEY`.

---

## Adding an Enterprise feature

1. Add a key to `ENTERPRISE_FEATURES` in `src/features.ts`.
2. Put the implementation here, or mark an existing file with `/* @license
Enterprise */` in its first ten lines — the root `LICENSE` carves out both.
3. Gate the entry point on `hasFeature()` / `requireFeature()`.
4. Make sure the community path still works when the gate returns `false`.

Step 4 is the one that matters. A feature that breaks the free product when it
is switched off is a bug, not a paid feature.
