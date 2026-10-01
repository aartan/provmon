import Link from "next/link";
import type { ReactNode } from "react";

import { logout } from "@/app/(auth)/actions";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";

// The layout reads the session cookie, so it cannot prerender a static shell.
export const instant = false;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-semibold">
              ProvMon
            </Link>
            <nav className="hidden text-sm text-muted-foreground sm:flex sm:gap-4">
              <Link href="/dashboard" className="hover:text-foreground">
                Dashboard
              </Link>
              <Link href="/products" className="hover:text-foreground">
                Products
              </Link>
              <Link href="/products/add" className="hover:text-foreground">
                Add product
              </Link>
              <Link href="/settings" className="hover:text-foreground">
                Settings
              </Link>
            </nav>
          </div>
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
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
