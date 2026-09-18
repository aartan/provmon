import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";

import authConfig from "@/auth.config";
import { db } from "@/lib/db";

/**
 * Full Auth.js configuration (Node.js runtime) with a credentials provider
 * and JWT sessions.
 *
 * Design choices:
 * - JWT sessions: no database session tables; sessions are signed with
 *   AUTH_SECRET and verified on every request.
 * - Passwords are hashed with bcrypt (cost 12) at registration time in
 *   `src/modules/users/password.ts` and only compared here.
 * - Authorization is enforced at the data layer: every user-owned query
 *   filters by the session user id.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        const parsed = z
          .object({
            email: z.email(),
            password: z.string().min(1),
          })
          .safeParse(credentials);

        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;

        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user) {
          return null;
        }

        const passwordMatches = await compare(password, user.passwordHash);
        if (!passwordMatches) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
});
