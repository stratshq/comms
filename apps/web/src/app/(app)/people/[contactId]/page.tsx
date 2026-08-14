import { notFound } from 'next/navigation';
import { getPersonProfile } from '@/server/queries';
import { requireDbUser } from '@/lib/session';
import { PersonProfile } from '@/components/people/person-profile';

export const dynamic = 'force-dynamic';

/**
 * A person's own page.
 *
 * Deliberately absent from the nav — you get here by clicking someone's face,
 * from the details panel or a group's member list. A "Contacts" nav entry
 * would frame this as a directory to browse; it isn't. It's the answer to
 * "who am I actually talking to", asked from inside a conversation.
 */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  await requireDbUser();

  const profile = await getPersonProfile(contactId);
  if (!profile) notFound();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PersonProfile
        data={{
          contact: {
            id: profile.contact.id,
            displayName: profile.contact.displayName,
            company: profile.contact.company,
            notes: profile.contact.notes,
            avatarUrl: profile.contact.avatarUrl,
            attributes: profile.contact.attributes,
            optedOut: Boolean(profile.contact.optedOutAt),
            syncedAt: profile.contact.syncedAt?.toISOString() ?? null,
          },
          identities: profile.identities,
          conversations: profile.conversations.map((c) => ({
            ...c,
            lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
          })),
          stats: {
            ...profile.stats,
            firstMessageAt: profile.stats.firstMessageAt?.toISOString() ?? null,
            lastInboundAt: profile.stats.lastInboundAt?.toISOString() ?? null,
          },
          photos: profile.photos,
          photoCount: profile.photoCount,
        }}
      />
    </div>
  );
}
