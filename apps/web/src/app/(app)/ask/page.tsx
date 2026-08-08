import { isAiConfigured } from '@comms/ai';
import { AskArchive } from '@/components/inbox/ask-archive';

export const dynamic = 'force-dynamic';

export default async function AskPage() {
  const aiEnabled = await isAiConfigured();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 overflow-y-auto p-6">
      <div>
        <h1 className="type-title text-lg">Ask your messages</h1>
        <p className="type-body mt-1 text-muted-foreground">
          Search finds the thread. This answers the question — and shows you which messages it
          read, so you can check it.
        </p>
      </div>

      {aiEnabled ? (
        <AskArchive />
      ) : (
        <p className="type-body rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground">
          Add an <span className="font-medium text-foreground">ANTHROPIC_API_KEY</span> to enable
          this.
        </p>
      )}
    </div>
  );
}
