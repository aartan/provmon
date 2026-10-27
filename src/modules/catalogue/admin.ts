import { env } from "@/lib/env";

/**
 * Retailer catalogue management permissions.
 *
 * The application has no role model, so discovery management can be
 * restricted with an explicit email allowlist. An empty allowlist means
 * every authenticated user may manage retailer discovery — the default for
 * a self-hosted single-user deployment.
 */
export function catalogueAdminEmails(): string[] {
  return env.CATALOGUE_ADMIN_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isCatalogueAdmin(
  email: string | null | undefined,
): boolean {
  const allowlist = catalogueAdminEmails();
  if (allowlist.length === 0) {
    return true;
  }
  return Boolean(email) && allowlist.includes(email!.trim().toLowerCase());
}
