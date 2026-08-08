import { getOrgSettings, getSetting } from '@/server/settings';
import { signaturesEnabled } from '@/server/signature';
import { getSplitInboxState } from '@/server/actions/views';
import { GeneralForm } from '@/components/settings/general-form';
import { SlaForm } from '@/components/settings/sla-form';
import { SignatureSettings } from '@/components/settings/signature-settings';
import { SplitInboxSettings } from '@/components/settings/split-inbox-settings';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function WorkspaceSettingsPage() {
  const org = await getOrgSettings();
  const sla =
    (await getSetting<{ firstResponseMinutes?: number; nextResponseMinutes?: number }>('sla')) ??
    {};
  const sigEnabled = await signaturesEnabled();
  const splitState = await getSplitInboxState();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Settings that apply to everyone on this workspace.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Name</CardTitle>
        </CardHeader>
        <CardContent>
          <GeneralForm orgName={org.orgName ?? 'Comms'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Split inbox</CardTitle>
        </CardHeader>
        <CardContent>
          <SplitInboxSettings state={splitState} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signatures</CardTitle>
        </CardHeader>
        <CardContent>
          <SignatureSettings enabled={sigEnabled} />
          <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
            People write their personal signature under Settings → Profile; each inbox's fallback
            signature lives under Settings → Inboxes.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service-level targets (SLA)</CardTitle>
        </CardHeader>
        <CardContent>
          <SlaForm sla={sla} />
        </CardContent>
      </Card>
    </div>
  );
}
