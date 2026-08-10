'use server';

import { and, desc, eq, isNull, resolvePreferences } from '@comms/db';
import { notifications, users } from '@comms/db';
import { db } from '@/server/db';
import { requireUser, requireWriter } from '@/lib/session';

export interface NotificationItem {
  id: string;
  body: string;
  conversationId: string | null;
  read: boolean;
  createdAt: Date;
}

export async function listNotifications(): Promise<{
  items: NotificationItem[];
  unread: number;
  /** Whether the bell should chime — the caller already polls this on every event. */
  soundEnabled: boolean;
}> {
  const user = await requireUser();
  const [rows, me] = await Promise.all([
    db.query.notifications.findMany({
      where: eq(notifications.userId, user.id),
      orderBy: [desc(notifications.createdAt)],
      limit: 30,
    }),
    db.query.users.findFirst({ where: eq(users.id, user.id), columns: { preferences: true } }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      body: r.body,
      conversationId: r.conversationId,
      read: Boolean(r.readAt),
      createdAt: r.createdAt,
    })),
    unread: rows.filter((r) => !r.readAt).length,
    soundEnabled: resolvePreferences(me?.preferences).notificationSound,
  };
}

export async function markNotificationRead(id: string): Promise<{ ok: true }> {
  const user = await requireWriter();
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  return { ok: true };
}

export async function markAllNotificationsRead(): Promise<{ ok: true }> {
  const user = await requireWriter();
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
  return { ok: true };
}
