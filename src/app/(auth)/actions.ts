"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashPassword } from "@/modules/users/password";

export type AuthFormState =
  | { status: "idle" }
  | { status: "error"; message: string };

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : null)),
  email: z.email().trim().toLowerCase(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

const AUTH_WINDOW_SECONDS = 60;
const AUTH_ATTEMPTS = 10;

async function enforceAuthRateLimit(scope: string): Promise<boolean> {
  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ??
    (await headers()).get("x-real-ip") ??
    "unknown";
  const result = await checkRateLimit(`${scope}:${ip}`, AUTH_ATTEMPTS, AUTH_WINDOW_SECONDS);
  if (!result.allowed) {
    logger.warn({ component: "auth", scope, ip }, "rate limit exceeded");
    return false;
  }
  return true;
}

export async function register(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!(await enforceAuthRateLimit("register"))) {
    return {
      status: "error",
      message: "Too many attempts. Please wait a minute and try again.",
    };
  }

  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const message =
      parsed.error.issues.find((i) => i.path[0] === "email") ??
      parsed.error.issues.find((i) => i.path[0] === "password");
    return { status: "error", message: message?.message ?? "Invalid input" };
  }

  const { name, email, password } = parsed.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return {
      status: "error",
      message: "An account with this email already exists.",
    };
  }

  const passwordHash = await hashPassword(password);
  const user = await db.user.create({ data: { email, name, passwordHash } });
  await db.notificationPreference.create({
    data: { userId: user.id },
  });
  logger.info({ component: "auth" }, "user registered");

  // Throws NEXT_REDIRECT on success, which Next.js handles.
  await signIn("credentials", {
    email,
    password,
    redirectTo: "/dashboard",
  });
  return { status: "idle" };
}

export async function login(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!(await enforceAuthRateLimit("login"))) {
    return {
      status: "error",
      message: "Too many attempts. Please wait a minute and try again.",
    };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const callbackUrl = String(formData.get("callbackUrl") ?? "/dashboard");

  if (!z.email().safeParse(email).success || password.length === 0) {
    return { status: "error", message: "Please enter a valid email and password." };
  }

  try {
    // Throws NEXT_REDIRECT on success, which Next.js handles.
    await signIn("credentials", { email, password, redirectTo: callbackUrl });
  } catch (error) {
    if (error instanceof AuthError) {
      return { status: "error", message: "Invalid email or password." };
    }
    throw error;
  }

  return { status: "idle" };
}

export async function logout(): Promise<void> {
  const { signOut } = await import("@/auth");
  await signOut({ redirectTo: "/login" });
}
