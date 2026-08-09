'use server';

import bcrypt from 'bcryptjs';
import { count } from '@comms/db';
import { users, OWNER_ROLE_ID } from '@comms/db';
import { db } from '@/server/db';
import { setSetting } from '@/server/settings';

export interface CreateAdminInput {
  name: string;
  email: string;
  password: string;
  orgName?: string;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * First-run only: provision the initial owner account. Refuses to run once any
 * user already exists, so the setup wizard can't be replayed to escalate.
 */
export async function createFirstAdmin(input: CreateAdminInput): Promise<ActionResult> {
  const [row] = await db.select({ value: count() }).from(users);
  if (Number(row?.value ?? 0) > 0) {
    return { ok: false, error: 'Setup has already been completed.' };
  }

  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, error: 'Enter a valid email address.' };
  if (input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }

  const hashedPassword = await bcrypt.hash(input.password, 12);
  await db.insert(users).values({
    name: input.name.trim() || 'Admin',
    email,
    hashedPassword,
    roleId: OWNER_ROLE_ID,
    status: 'active',
    emailVerified: new Date(),
  });

  await setSetting('org', {
    orgName: input.orgName?.trim() || 'Comms',
    setupCompleted: true,
  });

  return { ok: true };
}
