import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js configuration: no database or bcrypt imports, so the
 * Next.js Proxy (which runs on the edge runtime) can validate sessions with
 * a `NextAuth(authConfig)` instance. The full Node.js config with the
 * credentials provider lives in `src/auth.ts`.
 */
export default {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: process.env.AUTH_TRUST_HOST === "true",
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
