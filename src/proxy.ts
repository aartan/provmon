import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import authConfig from "@/auth.config";

/**
 * Optimistic route protection (Next.js 16 Proxy, formerly Middleware).
 *
 * This only redirects unauthenticated visitors away from app routes for a
 * good UX; it is NOT the security boundary. Real authorization happens in
 * server components, server actions, and route handlers, which verify the
 * session and scope every query to the signed-in user.
 */
const { auth } = NextAuth(authConfig);

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/inventory",
  "/products",
  "/catalogue",
  "/retailers",
  "/settings",
] as const;

export default async function proxy(request: NextRequest) {
  const session = await auth();
  const isLoggedIn = Boolean(session?.user);
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (!isLoggedIn && isProtected) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isLoggedIn && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/inventory", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/inventory/:path*",
    "/products/:path*",
    "/catalogue/:path*",
    "/retailers/:path*",
    "/settings/:path*",
    "/login",
    "/register",
  ],
};
