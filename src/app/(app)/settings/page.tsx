import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { getNotificationPreferences } from "@/modules/notifications/notification.service";
import { SettingsForm } from "@/app/(app)/settings/settings-form";

export const metadata: Metadata = {
  title: "Settings",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsFallback />}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsFallback() {
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function SettingsContent() {
  // Stop prerendering here; session and database reads run at request time.
  await connection();
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
