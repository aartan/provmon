import { afterEach, describe, expect, it, vi } from "vitest";

describe("catalogue admin allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows any authenticated user when the allowlist is empty", async () => {
    vi.stubEnv("CATALOGUE_ADMIN_EMAILS", "");
    const { isCatalogueAdmin } = await import("@/modules/catalogue/admin");

    expect(isCatalogueAdmin("someone@example.com")).toBe(true);
    expect(isCatalogueAdmin(null)).toBe(true);
  });

  it("restricts management to listed emails when configured", async () => {
    vi.stubEnv(
      "CATALOGUE_ADMIN_EMAILS",
      " Admin@Example.com , ops@example.com ",
    );
    const { isCatalogueAdmin } = await import("@/modules/catalogue/admin");

    expect(isCatalogueAdmin("admin@example.com")).toBe(true);
    expect(isCatalogueAdmin(" ADMIN@example.com ")).toBe(true);
    expect(isCatalogueAdmin("ops@example.com")).toBe(true);
    expect(isCatalogueAdmin("user@example.com")).toBe(false);
    expect(isCatalogueAdmin(null)).toBe(false);
    expect(isCatalogueAdmin(undefined)).toBe(false);
  });
});
