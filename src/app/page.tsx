import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";

// The session-driven actions stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export default function HomePage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          ProvMon
        </h1>
        <p className="max-w-md text-balance text-muted-foreground">
          Monitor product prices and stock across multiple retailers. Get
          notified by email when a product comes back in stock or drops to
          your target price.
        </p>
      </div>
      <Suspense
        fallback={
          <div className="flex gap-3">
            <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
            <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
          </div>
        }
      >
        <HomeActions />
      </Suspense>
    </main>
  );
}

async function HomeActions() {
  // Stop prerendering here; the session read runs at request time.
  await connection();
  const session = await auth();

  return (
    <div className="flex gap-3">
      {session?.user ? (
        <Button asChild>
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      ) : (
        <>
          <Button asChild>
            <Link href="/register">Get started</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </>
      )}
    </div>
  );
}
