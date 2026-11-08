import { describe, expect, it } from "vitest";

import type { RetailerPluginManifest } from "@provmon/retailer-plugin-sdk";

import {
  buildPluginConfig,
  redactPluginSecrets,
} from "@/modules/retailers/plugin/config";

const manifest = {
  apiVersion: 1,
  id: "example",
  name: "Example",
  entry: "./index.js",
  supportedDomains: ["example.test"],
  currency: "GBP",
  minCheckIntervalMs: 60_000,
  treatNotFoundAsOutOfStock: false,
  capabilities: ["url-monitoring"],
  configuration: [
    { key: "apiUrl", env: "EXAMPLE_API_URL", default: "https://example.test" },
    { key: "apiKey", env: "EXAMPLE_API_KEY", required: true, secret: true },
  ],
} satisfies RetailerPluginManifest;

describe("buildPluginConfig", () => {
  it("resolves defaults and reports missing required variables", () => {
    const missing = buildPluginConfig(manifest, {});
    expect(missing.config).toEqual({ apiUrl: "https://example.test" });
    expect(missing.missing).toEqual(["EXAMPLE_API_KEY"]);

    const resolved = buildPluginConfig(manifest, {
      EXAMPLE_API_KEY: "super-secret",
    });
    expect(resolved.config).toEqual({
      apiUrl: "https://example.test",
      apiKey: "super-secret",
    });
    expect(resolved.secretValues).toEqual(["super-secret"]);
  });

  it("redacts secret values from errors and messages", () => {
    expect(
      redactPluginSecrets(
        "request to api failed with token super-secret",
        ["super-secret"],
      ),
    ).toBe("request to api failed with token [redacted]");
  });
});
