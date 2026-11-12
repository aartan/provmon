import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { isCatalogueAdmin } from "@/modules/catalogue/admin";
import { listRetailerAdminViews } from "@/modules/catalogue/retailer-admin.service";
import { listPluginStatuses } from "@/modules/retailers/plugin";
import { RetailersManager } from "@/app/(app)/retailers/retailers-manager";

export const metadata: Metadata = {
  title: "Retailers",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export default function RetailersPage() {
  return (
    <Suspense fallback={<RetailersFallback />}>
      <RetailersContent />
    </Suspense>
  );
}

function RetailersFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-44 animate-pulse rounded-md bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function RetailersContent() {
  await connection();
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/retailers");
  }

  const retailers = await listRetailerAdminViews();
  return (
    <RetailersManager
      retailers={retailers}
      plugins={listPluginStatuses()}
      canManage={isCatalogueAdmin(session.user.email)}
    />
  );
}
