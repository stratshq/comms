import { requireDbUser } from '@/lib/session';
import { ProfileForm } from '@/components/settings/profile-form';
import { PasswordForm } from '@/components/settings/password-form';
import { SignatureForm } from '@/components/settings/signature-form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function ProfileSettingsPage() {
  const me = await requireDbUser();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="text-sm text-muted-foreground">
          How you appear to the rest of the team — on assignments, notes, and mentions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProfileForm name={me.name ?? ''} image={me.image ?? ''} email={me.email} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signature</CardTitle>
        </CardHeader>
        <CardContent>
          <SignatureForm signature={me.preferences?.signature ?? ''} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Email</p>
              <p className="text-xs text-muted-foreground">
                You sign in with this address. Ask an admin to change it.
              </p>
            </div>
            <span className="truncate text-muted-foreground">{me.email}</span>
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <div>
              <p className="font-medium">Role</p>
              <p className="text-xs text-muted-foreground">
                Decides what you can change in this workspace. Only an admin can change it.
              </p>
            </div>
            <Badge variant="secondary" className="capitalize">
              {me.roleName}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
        </CardHeader>
        <CardContent>
          {me.hasPassword ? (
            <PasswordForm />
          ) : (
            <p className="text-sm text-muted-foreground">
              You sign in with a single sign-on provider or an email link, so there is no password
              on this account.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
