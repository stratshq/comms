import { requirePermissionPage } from '@/lib/session';
import { listTags } from '@/server/queries';
import { TagManager } from '@/components/settings/tag-manager';

export const dynamic = 'force-dynamic';

export default async function TagsSettingsPage() {
  await requirePermissionPage('workspace.manage');
  const tags = await listTags();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Tags</h2>
        <p className="text-sm text-muted-foreground">
          Organize conversations with color-coded tags.
        </p>
      </div>
      <TagManager tags={tags} />
    </div>
  );
}
