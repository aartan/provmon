import {
  PLUGIN_API_VERSION,
  type PluginCapability,
  type RetailerPluginManifest,
} from "./contracts.js";
import { parseRetailerPluginManifest } from "./schemas.js";

/** Validate an untrusted `provmon.plugin.json` payload. */
export function validateRetailerPluginManifest(
  value: unknown,
): RetailerPluginManifest {
  return parseRetailerPluginManifest(value);
}

export function supportsPluginApiVersion(apiVersion: number): boolean {
  return apiVersion === PLUGIN_API_VERSION;
}

export function hasPluginCapability(
  manifest: RetailerPluginManifest,
  capability: PluginCapability,
): boolean {
  return manifest.capabilities.includes(capability);
}
