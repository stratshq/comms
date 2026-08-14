import { requireElevatedPage } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Everything under this route group changes the whole workspace. The shell
 * requires any workspace permission; each page inside additionally checks the
 * specific permission it needs. The group adds no URL segment —
 * `/settings/team` and friends keep the paths they have always had.
 */
export default async function AdminSettingsLayout({ children }: { children: React.ReactNode }) {
  await requireElevatedPage();
  return <>{children}</>;
}
