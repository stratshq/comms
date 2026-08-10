'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { eq } from '@comms/db';
import { users, type UserPreferences } from '@comms/db';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Actions in this file are the counterpart to `admin.ts`: every one of them is
 * scoped to the caller's own row, so an agent can manage their account without
 * any workspace-level permission.
 */

/** Update your own display name and avatar. */
export async function updateProfile(input: {
  name: string;
  image?: string | null;
}): Promise<ActionResult> {
  const me = await requireWriter();

  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length > 80) return { ok: false, error: 'Name must be 80 characters or fewer.' };

  const image = input.image?.trim() || null;
  if (image && !/^https?:\/\//i.test(image)) {
    return { ok: false, error: 'Avatar must be a http(s) image URL.' };
  }

  await db.update(users).set({ name, image }).where(eq(users.id, me.id));
  revalidatePath('/settings/profile');
  // The sidebar renders the name and avatar on every screen.
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Change your own password, proving you know the current one first. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<ActionResult> {
  const me = await requireWriter();

  if (input.newPassword.length < 8) {
    return { ok: false, error: 'New password must be 8+ characters.' };
  }
  if (input.newPassword === input.currentPassword) {
    return { ok: false, error: 'New password must be different from the current one.' };
  }

  const row = await db.query.users.findFirst({
    where: eq(users.id, me.id),
    columns: { hashedPassword: true },
  });
  if (!row?.hashedPassword) {
    return {
      ok: false,
      error: 'This account signs in without a password, so there is nothing to change.',
    };
  }

  const ok = await bcrypt.compare(input.currentPassword, row.hashedPassword);
  if (!ok) return { ok: false, error: 'Current password is incorrect.' };

  await db
    .update(users)
    .set({ hashedPassword: await bcrypt.hash(input.newPassword, 12) })
    .where(eq(users.id, me.id));
  return { ok: true };
}

/** Save your personal signature (empty string removes it). */
export async function updateSignaturePreference(signature: string): Promise<ActionResult> {
  const me = await requireWriter();
  const trimmed = signature.trim().slice(0, 500);

  const row = await db.query.users.findFirst({
    where: eq(users.id, me.id),
    columns: { preferences: true },
  });
  const preferences: UserPreferences = { ...(row?.preferences ?? {}) };
  if (trimmed) preferences.signature = trimmed;
  else delete preferences.signature;

  await db.update(users).set({ preferences }).where(eq(users.id, me.id));
  revalidatePath('/settings/profile');
  return { ok: true };
}

/** Merge a patch into your own notification preferences. */
export async function updateNotificationPreferences(patch: UserPreferences): Promise<ActionResult> {
  const me = await requireWriter();

  const row = await db.query.users.findFirst({
    where: eq(users.id, me.id),
    columns: { preferences: true },
  });

  await db
    .update(users)
    .set({ preferences: { ...(row?.preferences ?? {}), ...patch } })
    .where(eq(users.id, me.id));
  revalidatePath('/settings/preferences');
  return { ok: true };
}

/**
 * Save keyboard shortcuts.
 *
 * Stored as a preset plus a diff rather than a full map: when a later version
 * adds an action, everyone picks up its default binding instead of ending up
 * with an action that has no keys and no way to discover that.
 */
export async function updateKeymap(input: {
  preset: string;
  overrides: Record<string, string[]>;
  enterSends: boolean;
}): Promise<ActionResult> {
  const me = await requireWriter();

  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, me.id));

  const preferences: UserPreferences = {
    ...(row?.preferences ?? {}),
    keymap: {
      preset: input.preset,
      overrides: input.overrides,
      enterSends: input.enterSends,
    },
  };

  await db.update(users).set({ preferences }).where(eq(users.id, me.id));
  revalidatePath('/settings/keyboard');
  // Every screen carries the shortcut listener and the cheat sheet.
  revalidatePath('/', 'layout');
  return { ok: true };
}
