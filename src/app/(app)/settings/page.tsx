import type { Metadata } from "next";

import { auth } from "@/auth";
import { getNotificationPreferences } from "@/modules/notifications/notification.service";
import { SettingsForm } from "@/app/(app)/settings/settings-form";

export const metadata: Metadata = {
  title: "Settings",
};

export const instant = false;

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const preferences = await getNotificationPreferences(session.user.id);

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Account, email, and notification preferences.
        </p>
      </div>
      <SettingsForm
        email={session.user.email ?? ""}
        preferences={preferences}
      />
    </div>
  );
}
