'use server';

import { revalidatePath } from 'next/cache';
import { eq, count } from '@comms/db';
import { inboxes, channelConnections } from '@comms/db';
import {
  BlueBubblesClient,
  encryptSecret,
  decryptSecret,
  randomToken,
  loadConfig,
  enqueueMaintenance,
  COMMS_WEBHOOK_EVENTS,
  COMMS_WEBHOOK_VERSION,
  checkServerUrl,
  describeConnectionError,
  diagnoseConnectionError,
  type ConnectionProblem,
  logger,
} from '@comms/core';
import { db } from '@/server/db';
import { requirePermission } from '@/lib/session';

const log = logger.child({ action: 'connections' });

export type ConnectResult =
  | {
      ok: true;
      connectionId: string;
      privateApi: boolean;
      webhookRegistered: boolean;
      /** True when we reattached to an existing inbox instead of making a new one. */
      adopted: boolean;
    }
  | { ok: false; error: string };

/**
 * Connect a BlueBubbles server: validate credentials, persist an encrypted
 * connection, register the inbound webhook, and queue an initial history sync.
 */
export async function connectBlueBubbles(input: {
  name: string;
  serverUrl: string;
  password: string;
}): Promise<ConnectResult> {
  await requirePermission('inboxes.manage');
  const cfg = loadConfig();

  const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
  const password = input.password.trim();
  if (!password) return { ok: false, error: 'The BlueBubbles password is required.' };

  // Catch addresses that can never work from a hosted deployment before we
  // waste a request and surface an opaque "fetch failed".
  const urlProblem = checkServerUrl(serverUrl);
  if (urlProblem) return { ok: false, error: `${urlProblem.message} ${urlProblem.hint}` };

  // 1. Validate by hitting the server.
  const probe = new BlueBubblesClient({ serverUrl, password });
  let privateApi = false;
  let serverVersion: string | undefined;
  let osVersion: string | undefined;
  try {
    const info = await probe.serverInfo();
    privateApi = Boolean(info.private_api);
    serverVersion = info.server_version;
    osVersion = info.os_version;
  } catch (err) {
    return { ok: false, error: describeConnectionError(err, serverUrl) };
  }

  // 2. Reuse an orphaned inbox if there is one, otherwise create.
  //
  //    Disconnecting removes the connection but leaves the inbox (it still
  //    owns the conversation history). Without this, reconnecting the same
  //    number produced a SECOND inbox and stranded the history in the first —
  //    the single most confusing thing this app could do.
  const allInboxes = await db.query.inboxes.findMany({ with: { connections: true } });
  const orphan = allInboxes.find((i) => i.connections.length === 0);

  let inbox: typeof inboxes.$inferSelect | undefined;
  let adopted = false;

  if (orphan) {
    const [updated] = await db
      .update(inboxes)
      .set({
        name: input.name.trim() || orphan.name,
        settings: { ...orphan.settings, sendTypingIndicators: privateApi },
      })
      .where(eq(inboxes.id, orphan.id))
      .returning();
    inbox = updated;
    adopted = true;
  } else {
    const [countRow] = await db.select({ value: count() }).from(inboxes);
    const inboxCount = Number(countRow?.value ?? 0);
    const [created] = await db
      .insert(inboxes)
      .values({
        name: input.name.trim() || 'iMessage',
        channelType: 'imessage',
        isDefault: inboxCount === 0,
        settings: { markReadOnReply: false, sendTypingIndicators: privateApi },
      })
      .returning();
    inbox = created;
  }
  if (!inbox) return { ok: false, error: 'Failed to create inbox.' };

  // 3. Persist the connection with the encrypted password.
  const webhookSecret = randomToken(24);
  const [connection] = await db
    .insert(channelConnections)
    .values({
      inboxId: inbox.id,
      provider: 'bluebubbles',
      serverUrl,
      credentialsEncrypted: encryptSecret(password, cfg.appSecret),
      webhookSecret,
      status: 'connected',
      lastHeartbeatAt: new Date(),
      webhookVersion: COMMS_WEBHOOK_VERSION,
      capabilities: { privateApi, serverVersion, macosVersion: osVersion },
    })
    .returning();
  if (!connection) return { ok: false, error: 'Failed to save connection.' };

  // 4. Register the inbound webhook (best-effort: a localhost APP_URL can't be reached).
  let webhookRegistered = false;
  try {
    const webhookUrl = `${cfg.appUrl}/api/webhooks/bluebubbles/${connection.id}?secret=${webhookSecret}`;
    const hook = await probe.registerWebhook(webhookUrl, COMMS_WEBHOOK_EVENTS);
    await db
      .update(channelConnections)
      .set({ providerWebhookId: String(hook.id) })
      .where(eq(channelConnections.id, connection.id));
    webhookRegistered = true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'webhook registration failed (will need retry)');
    await db
      .update(channelConnections)
      .set({ lastError: `Webhook registration failed: ${(err as Error).message}` })
      .where(eq(channelConnections.id, connection.id));
  }

  // 5. Kick off a history backfill, heartbeat, and an initial contact sync so
  //    conversations show real names instead of raw phone numbers.
  await enqueueMaintenance({ type: 'backfill', connectionId: connection.id }).catch(() => {});
  await enqueueMaintenance({ type: 'heartbeat', connectionId: connection.id }).catch(() => {});
  await enqueueMaintenance({ type: 'contactSync', connectionId: connection.id }).catch(() => {});

  revalidatePath('/settings/inboxes');
  revalidatePath('/inbox');
  return { ok: true, connectionId: connection.id, privateApi, webhookRegistered, adopted };
}

/**
 * Update a connection's server URL (and optionally its password) IN PLACE.
 *
 * This exists because tunnel URLs rotate (Cloudflare quick tunnels change on
 * every BlueBubbles restart). Before this action the only path was
 * connectBlueBubbles, which creates a brand-new inbox — duplicating the inbox
 * and stranding all conversation history. Editing in place keeps the same
 * inbox, conversations, and webhook secret; only the transport address moves.
 */
export async function updateConnectionServerUrl(input: {
  connectionId: string;
  serverUrl: string;
  /** Optional: also rotate the password. Blank/omitted keeps the stored one. */
  password?: string;
}): Promise<{ ok: boolean; privateApi?: boolean; webhookRegistered?: boolean; error?: string }> {
  await requirePermission('inboxes.manage');
  const cfg = loadConfig();

  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, input.connectionId),
  });
  if (!conn) return { ok: false, error: 'Connection not found.' };

  const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
  const urlProblem = checkServerUrl(serverUrl);
  if (urlProblem) return { ok: false, error: `${urlProblem.message} ${urlProblem.hint}` };
  const password = input.password?.trim() || decryptSecret(conn.credentialsEncrypted, cfg.appSecret);

  // 1. Verify the new address actually answers with these credentials before
  //    touching the stored row — a typo must not take a working channel down.
  const probe = new BlueBubblesClient({ serverUrl, password });
  let privateApi = false;
  let serverVersion: string | undefined;
  let osVersion: string | undefined;
  try {
    const info = await probe.serverInfo();
    privateApi = Boolean(info.private_api);
    serverVersion = info.server_version;
    osVersion = info.os_version;
  } catch (err) {
    return { ok: false, error: describeConnectionError(err, serverUrl) };
  }

  // 2. Persist the move. Same row, same inbox, same webhook secret.
  await db
    .update(channelConnections)
    .set({
      serverUrl,
      ...(input.password?.trim()
        ? { credentialsEncrypted: encryptSecret(input.password.trim(), cfg.appSecret) }
        : {}),
      status: 'connected',
      lastHeartbeatAt: new Date(),
      lastError: null,
      capabilities: { privateApi, serverVersion, macosVersion: osVersion },
    })
    .where(eq(channelConnections.id, conn.id));

  // 3. Re-register the webhook against the new server. The old registration
  //    lives on the old (dead) server, so deleting it is best-effort only.
  let webhookRegistered = false;
  try {
    const existing = await probe.listWebhooks().catch(() => [] as { id: number | string; url: string }[]);
    for (const hook of existing) {
      if (hook.url?.includes(`/api/webhooks/bluebubbles/${conn.id}`)) {
        await probe.deleteWebhook(hook.id).catch(() => {});
      }
    }
    const url = `${cfg.appUrl}/api/webhooks/bluebubbles/${conn.id}?secret=${conn.webhookSecret}`;
    const hook = await probe.registerWebhook(url, COMMS_WEBHOOK_EVENTS);
    await db
      .update(channelConnections)
      .set({ providerWebhookId: String(hook.id) })
      .where(eq(channelConnections.id, conn.id));
    webhookRegistered = true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'webhook re-registration after URL change failed');
    await db
      .update(channelConnections)
      .set({ lastError: `Webhook registration failed: ${(err as Error).message}` })
      .where(eq(channelConnections.id, conn.id));
  }

  // 4. Backfill anything missed while the old URL was dead.
  await enqueueMaintenance({ type: 'backfill', connectionId: conn.id }).catch(() => {});
  await enqueueMaintenance({ type: 'heartbeat', connectionId: conn.id }).catch(() => {});

  revalidatePath('/settings/inboxes');
  return { ok: true, privateApi, webhookRegistered };
}

export type VerifyResult =
  | { ok: true; privateApi: boolean; serverVersion?: string; macosVersion?: string }
  | { ok: false; problem: ConnectionProblem; message: string; hint: string };

/**
 * Check a URL + password WITHOUT saving anything, and translate whatever went
 * wrong into something a non-technical person can act on. Used by the guided
 * setup so step 6 can say "that password doesn't match" instead of surfacing a
 * raw HTTP error.
 */
export async function verifyBlueBubbles(input: {
  serverUrl: string;
  password: string;
}): Promise<VerifyResult> {
  await requirePermission('inboxes.manage');

  const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
  const password = input.password.trim();

  const urlProblem = checkServerUrl(serverUrl);
  if (urlProblem) {
    return { ok: false, problem: urlProblem.problem, message: urlProblem.message, hint: urlProblem.hint };
  }
  if (!password) {
    return {
      ok: false,
      problem: 'password',
      message: 'You need to enter your BlueBubbles password.',
      hint: 'This is the password you chose inside the BlueBubbles app on your Mac — not your Apple ID password.',
    };
  }

  try {
    const info = await new BlueBubblesClient({ serverUrl, password, timeoutMs: 12_000 }).serverInfo();
    return {
      ok: true,
      privateApi: Boolean(info.private_api),
      serverVersion: info.server_version,
      macosVersion: info.os_version,
    };
  } catch (err) {
    const d = diagnoseConnectionError(err, serverUrl);
    return { ok: false, problem: d.problem, message: d.message, hint: d.hint };
  }
}

/** Re-test a connection and refresh its capabilities. */
export async function testConnection(
  connectionId: string,
): Promise<{ ok: boolean; privateApi?: boolean; error?: string }> {
  await requirePermission('inboxes.manage');
  const cfg = loadConfig();
  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
  });
  if (!conn) return { ok: false, error: 'Connection not found.' };

  try {
    const client = new BlueBubblesClient({
      serverUrl: conn.serverUrl,
      password: decryptSecret(conn.credentialsEncrypted, cfg.appSecret),
    });
    const info = await client.serverInfo();
    await db
      .update(channelConnections)
      .set({
        status: 'connected',
        lastHeartbeatAt: new Date(),
        lastError: null,
        capabilities: {
          privateApi: Boolean(info.private_api),
          serverVersion: info.server_version,
          macosVersion: info.os_version,
        },
      })
      .where(eq(channelConnections.id, connectionId));
    revalidatePath('/settings/inboxes');
    return { ok: true, privateApi: Boolean(info.private_api) };
  } catch (err) {
    const explained = describeConnectionError(err, conn.serverUrl);
    await db
      .update(channelConnections)
      .set({ status: 'error', lastError: explained })
      .where(eq(channelConnections.id, connectionId));
    revalidatePath('/settings/inboxes');
    return { ok: false, error: explained };
  }
}

/**
 * Trigger a contact sync immediately and report what it did, so a sync that
 * quietly matches nothing is visible instead of mysterious.
 */
export async function syncContactsNow(
  connectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requirePermission('inboxes.manage');
  try {
    await enqueueMaintenance({ type: 'contactSync', connectionId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Re-register the webhook (e.g. after the public URL changes). */
export async function reRegisterWebhook(
  connectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requirePermission('inboxes.manage');
  const cfg = loadConfig();
  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
  });
  if (!conn) return { ok: false, error: 'Connection not found.' };

  try {
    const client = new BlueBubblesClient({
      serverUrl: conn.serverUrl,
      password: decryptSecret(conn.credentialsEncrypted, cfg.appSecret),
    });
    if (conn.providerWebhookId) {
      await client.deleteWebhook(conn.providerWebhookId).catch(() => {});
    }
    const url = `${cfg.appUrl}/api/webhooks/bluebubbles/${conn.id}?secret=${conn.webhookSecret}`;
    const hook = await client.registerWebhook(url, COMMS_WEBHOOK_EVENTS);
    await db
      .update(channelConnections)
      .set({ providerWebhookId: String(hook.id), lastError: null })
      .where(eq(channelConnections.id, connectionId));
    revalidatePath('/settings/inboxes');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateInboxSettings(
  inboxId: string,
  settings: {
    autoAssign?: boolean;
    assignStrategy?: 'round_robin' | 'least_busy';
    markReadOnReply?: boolean;
    csatEnabled?: boolean;
    csatMessage?: string;
    /** Fallback signature for replies from this number (see server/signature). */
    signature?: string;
  },
): Promise<{ ok: boolean }> {
  await requirePermission('inboxes.manage');
  const inbox = await db.query.inboxes.findFirst({ where: eq(inboxes.id, inboxId) });
  if (!inbox) return { ok: false };
  await db
    .update(inboxes)
    .set({ settings: { ...inbox.settings, ...settings } })
    .where(eq(inboxes.id, inboxId));
  revalidatePath('/settings/inboxes');
  return { ok: true };
}

export async function disconnect(connectionId: string): Promise<{ ok: boolean }> {
  await requirePermission('inboxes.manage');
  const cfg = loadConfig();
  const conn = await db.query.channelConnections.findFirst({
    where: eq(channelConnections.id, connectionId),
  });
  if (conn) {
    try {
      if (conn.providerWebhookId) {
        const client = new BlueBubblesClient({
          serverUrl: conn.serverUrl,
          password: decryptSecret(conn.credentialsEncrypted, cfg.appSecret),
        });
        await client.deleteWebhook(conn.providerWebhookId).catch(() => {});
      }
    } catch {
      /* best effort */
    }
    await db.delete(channelConnections).where(eq(channelConnections.id, connectionId));
  }
  revalidatePath('/settings/inboxes');
  return { ok: true };
}
