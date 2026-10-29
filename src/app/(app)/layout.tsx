import Link from "next/link";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { connection } from "next/server";

import { logout } from "@/app/(auth)/actions";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";

// The session-driven part of the header streams in behind a Suspense
// boundary; the prerendered shell must not read the session cookie.
export const instant = false;

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/inventory" className="font-semibold">
              ProvMon
            </Link>
            <nav className="hidden text-sm text-muted-foreground md:flex md:gap-3 lg:gap-4">
              <Link href="/dashboard" className="hover:text-foreground">
                Dashboard
              </Link>
              <Link href="/catalogue" className="hover:text-foreground">
                Catalogue
              </Link>
              <Link href="/inventory" className="hover:text-foreground">
                Inventory
              </Link>
              <Link href="/products" className="hover:text-foreground">
                Monitoring
              </Link>
              <Link
                href="/products/add"
                className="hidden hover:text-foreground lg:inline"
              >
                Add monitor
              </Link>
              <Link href="/retailers" className="hover:text-foreground">
                Retailers
              </Link>
              <Link href="/settings" className="hover:text-foreground">
                Settings
              </Link>
            </nav>
          </div>
          <Suspense
            fallback={
              <div className="h-9 w-32 animate-pulse rounded-md bg-muted" />
            }
          >
            <SessionMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}

async function SessionMenu() {
  // Auth.js reads the session without going through a framework-tracked
  // request API, so stop prerendering here: this component only renders
  // at request time (its Suspense fallback fills the static shell).
  await connection();
  const session = await auth();

  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {session?.user?.email}
      </span>
      <form action={logout}>
        <Button variant="outline" size="sm" type="submit">
          Sign out
        </Button>
      </form>
    </div>
  );
}
