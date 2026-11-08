import type { PluginLogger } from "@provmon/retailer-plugin-sdk";

import { logger as rootLogger } from "@/lib/logger";

import { redactPluginSecrets } from "./config";

/**
 * Create the logger handed to a plugin. Plugin logs are attributed to the
 * package version so operational issues can be traced to a release.
 *
 * Secret-marked config values are redacted from messages and log fields.
 */
export function createPluginLogger(
  pluginId: string,
  pluginVersion: string,
  secretValues: readonly string[] = [],
): PluginLogger {
  const child = rootLogger.child({
    component: "retailer-plugin",
    pluginId,
    pluginVersion,
  });

  const message = (value: string | undefined): string | undefined =>
    value === undefined
      ? undefined
      : redactPluginSecrets(value, secretValues);

  const fields = (
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    redactRecord(value, secretValues);

  return {
    debug(logFields, logMessage) {
      child.debug(fields(logFields), message(logMessage));
    },
    info(logFields, logMessage) {
      child.info(fields(logFields), message(logMessage));
    },
    warn(logFields, logMessage) {
      child.warn(fields(logFields), message(logMessage));
    },
    error(logFields, logMessage) {
      child.error(fields(logFields), message(logMessage));
    },
  };
}

function redactRecord(
  value: Record<string, unknown>,
  secretValues: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    result[key] = redactValue(field, secretValues);
  }
  return result;
}

function redactValue(
  value: unknown,
  secretValues: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactPluginSecrets(value, secretValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues));
  }
  if (value instanceof Error) {
    const redacted = new Error(redactPluginSecrets(value.message, secretValues));
    redacted.name = value.name;
    redacted.stack = value.stack
      ? redactPluginSecrets(value.stack, secretValues)
      : undefined;
    return redacted;
  }
  if (value && typeof value === "object") {
    return redactRecord(
      value as Record<string, unknown>,
      secretValues,
    );
  }
  return value;
}

export const noopPluginLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
