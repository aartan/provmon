import type { Metadata } from "next";

import { auth } from "@/auth";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Dashboard",
};

// The page reads the session cookie, so it cannot prerender a static shell.
export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    return null; // The proxy redirects, but stay safe.
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back{session.user.name ? `, ${session.user.name}` : ""}.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["Monitored products", "In stock", "Meeting target price", "Notifications"].map(
          (label) => (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">0</div>
              </CardContent>
            </Card>
          ),
        )}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Setup progress
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <Badge variant="secondary">Phase 1</Badge>{" "}
          Authentication and project foundation are in place. Product
          monitoring arrives in the next phases.
        </CardContent>
      </Card>
    </div>
  );
}
