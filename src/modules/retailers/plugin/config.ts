import type {
  PluginConfigurationField,
  RetailerPluginManifest,
} from "@provmon/retailer-plugin-sdk";

export interface PluginConfigResult {
  config: Record<string, unknown>;
  missing: string[];
  /** Values that must never be logged or included in error messages. */
  secretValues: string[];
}

/**
 * Build a plugin config object from the environment variables declared in
 * its manifest. Values are intentionally left as strings so the plugin's
 * own Zod schema decides how to coerce and validate them.
 */
export function buildPluginConfig(
  manifest: RetailerPluginManifest,
  env: Record<string, string | undefined> = process.env,
): PluginConfigResult {
  const config: Record<string, unknown> = {};
  const missing: string[] = [];
  const secretValues: string[] = [];

  for (const field of manifest.configuration ?? []) {
    const value = resolveField(field, env);
    if (value === undefined) {
      if (field.required) {
        missing.push(field.env);
      }
      continue;
    }
    config[field.key] = value;
    if (field.secret && typeof value === "string" && value.length > 0) {
      secretValues.push(value);
    }
  }

  return { config, missing, secretValues };
}

function resolveField(
  field: PluginConfigurationField,
  env: Record<string, string | undefined>,
): unknown {
  const raw = env[field.env];
  if (raw !== undefined && raw !== "") {
    return raw;
  }
  return field.default;
}

/**
 * Remove known secret values from a message before logging or returning
 * it in a status record.
 */
export function redactPluginSecrets(
  message: string,
  secretValues: readonly string[],
): string {
  let redacted = message;
  for (const value of secretValues) {
    if (value.length > 0) {
      redacted = redacted.split(value).join("[redacted]");
    }
  }
  return redacted;
}
