import { eq } from '@comms/db';
import { contacts } from '@comms/db';
import { getPresignedUrl, isStorageEnabled } from '@comms/core';
import { db } from '@/server/db';
import { getCurrentUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A contact's address-book photo.
 *
 * Served from the database, where the sync now puts it. The S3 branch is only
 * for installs that synced before that changed and still have a key on the
 * row — nothing writes one any more.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { contactId } = await params;
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
    columns: { avatarData: true, avatarMime: true, avatarStorageKey: true, updatedAt: true },
  });
  if (!contact) return new Response('Not found', { status: 404 });

  if (contact.avatarData) {
    const bytes = Buffer.from(contact.avatarData, 'base64');
    // Private, because the photo is only for signed-in members of this
    // workspace; revalidated against the row's mtime so a re-sync shows the
    // new face without waiting the hour out.
    const etag = `W/"${contactId}-${contact.updatedAt?.getTime() ?? 0}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(bytes, {
      headers: {
        'Content-Type': contact.avatarMime ?? 'image/jpeg',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=3600, must-revalidate',
        ETag: etag,
      },
    });
  }

  if (contact.avatarStorageKey && isStorageEnabled()) {
    const url = await getPresignedUrl(contact.avatarStorageKey, 3600);
    return Response.redirect(url, 302);
  }

  return new Response('Not found', { status: 404 });
}
