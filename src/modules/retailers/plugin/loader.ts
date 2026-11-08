import { pathToFileURL } from "node:url";

import type {
  PluginLogger,
  RetailerPlugin,
  RetailerPluginInstance,
} from "@provmon/retailer-plugin-sdk";

import { logger } from "@/lib/logger";
import {
  retailerRegistry,
  type RetailerRegistry,
} from "@/modules/retailers/core/retailer-registry";

import { PluginRetailerAdapter } from "./adapter";
import { buildPluginConfig, redactPluginSecrets } from "./config";
import {
  discoverPluginPackages,
  type PluginDiscoveryError,
  type PluginPackageDescriptor,
} from "./discovery";
import { createPluginLogger } from "./logger";

export type PluginLoadStatus = "LOADED" | "FAILED";

export interface PluginStatusRecord {
  packageName: string;
  id: string | null;
  name: string | null;
  version: string | null;
  apiVersion: number | null;
  status: PluginLoadStatus;
  error: string | null;
  capabilities: string[];
  supportedDomains: string[];
}

export interface LoadRetailerPluginsOptions {
  pluginDir?: string;
  env?: Record<string, string | undefined>;
  registry?: RetailerRegistry;
  /** Override for tests; defaults to the application logger. */
  pluginLogger?: (id: string, version: string) => PluginLogger;
}

export interface LoadRetailerPluginsResult {
  pluginDir: string;
  loaded: number;
  failed: number;
  skipped: number;
  statuses: PluginStatusRecord[];
}

const log = logger.child({ component: "retailer-plugins" });

let loadPromise: Promise<LoadRetailerPluginsResult> | null = null;

const statuses = new Map<string, PluginStatusRecord>();
const loadedInstances = new Map<string, RetailerPluginInstance>();

function statusForDescriptor(
  descriptor: PluginPackageDescriptor,
): PluginStatusRecord {
  return {
    packageName: descriptor.packageName,
    id: descriptor.manifest.id,
    name: descriptor.manifest.name,
    version: descriptor.version,
    apiVersion: descriptor.manifest.apiVersion,
    status: "FAILED",
    error: null,
    capabilities: [...descriptor.manifest.capabilities],
    supportedDomains: [...descriptor.manifest.supportedDomains],
  };
}

function statusForDiscoveryError(
  error: PluginDiscoveryError,
): PluginStatusRecord {
  return {
    packageName: error.packageName,
    id: error.id ?? null,
    name: error.name ?? null,
    version: error.version ?? null,
    apiVersion: error.apiVersion ?? null,
    status: "FAILED",
    error: error.message,
    capabilities: error.capabilities ?? [],
    supportedDomains: error.supportedDomains ?? [],
  };
}

function remember(status: PluginStatusRecord): void {
  statuses.set(status.packageName, status);
}

async function importPluginEntry(
  entryPath: string,
): Promise<Record<string, unknown>> {
  return import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */
    pathToFileURL(entryPath).href
  ) as Promise<Record<string, unknown>>;
}

function getPluginExport(module: Record<string, unknown>): RetailerPlugin {
  const candidate =
    (module.default as unknown) ??
    (module.plugin as unknown) ??
    module;

  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { create?: unknown }).create !== "function"
  ) {
    throw new Error(
      "Plugin entry must export a default object with a create() function",
    );
  }
  return candidate as RetailerPlugin;
}

function validatePluginInstance(
  descriptor: PluginPackageDescriptor,
  instance: RetailerPluginInstance,
): void {
  if (
    !instance ||
    typeof instance !== "object" ||
    typeof instance.parseProductUrl !== "function" ||
    typeof instance.getProduct !== "function"
  ) {
    throw new Error(
      `Plugin ${descriptor.manifest.id} did not return a valid instance (parseProductUrl and getProduct are required)`,
    );
  }

  const declaresCatalogue = descriptor.manifest.capabilities.includes(
    "catalogue-discovery",
  );
  if (declaresCatalogue && !instance.catalogue) {
    throw new Error(
      `Plugin ${descriptor.manifest.id} declares catalogue-discovery but did not expose a catalogue implementation`,
    );
  }
  if (!declaresCatalogue && instance.catalogue) {
    throw new Error(
      `Plugin ${descriptor.manifest.id} exposes a catalogue but did not declare the catalogue-discovery capability`,
    );
  }
  if (
    instance.catalogue &&
    typeof instance.catalogue.fetchPage !== "function"
  ) {
    throw new Error(
      `Plugin ${descriptor.manifest.id} returned an invalid catalogue implementation`,
    );
  }
}

async function loadDescriptor(
  descriptor: PluginPackageDescriptor,
  options: LoadRetailerPluginsOptions,
  registry: RetailerRegistry,
): Promise<PluginStatusRecord> {
  const status = statusForDescriptor(descriptor);
  const env = options.env ?? process.env;

  const configResult = buildPluginConfig(descriptor.manifest, env);
  if (configResult.missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${configResult.missing.join(", ")}`,
    );
  }

  let pluginModule: Record<string, unknown>;
  try {
    pluginModule = await importPluginEntry(descriptor.entryPath);
  } catch (error) {
    throw new Error(
      `Could not import plugin entry ${descriptor.entryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const plugin = getPluginExport(pluginModule);
  let config: unknown = configResult.config;
  if (plugin.configSchema) {
    const parsed = plugin.configSchema.safeParse(configResult.config);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid plugin configuration: ${issues}`);
    }
    config = parsed.data;
  }

  const pluginLogger =
    options.pluginLogger?.(descriptor.manifest.id, descriptor.version) ??
    createPluginLogger(
      descriptor.manifest.id,
      descriptor.version,
      configResult.secretValues,
    );

  const instance = await plugin.create({
    config,
    logger: pluginLogger,
    plugin: {
      id: descriptor.manifest.id,
      version: descriptor.version,
    },
  });

  validatePluginInstance(descriptor, instance);

  const adapter = new PluginRetailerAdapter(
    descriptor,
    instance,
    pluginLogger,
  );
  registry.register(adapter);
  loadedInstances.set(descriptor.manifest.id, instance);

  status.status = "LOADED";
  status.error = null;
  log.info(
    {
      packageName: descriptor.packageName,
      pluginId: descriptor.manifest.id,
      pluginVersion: descriptor.version,
      capabilities: descriptor.manifest.capabilities,
      domains: descriptor.manifest.supportedDomains,
    },
    "retailer plugin loaded",
  );
  return status;
}

/**
 * Discover and load every plugin configured in the plugin directory.
 *
 * This function never throws for a single bad plugin: failures are recorded
 * in status records so the application can start and surface the problem
 * without losing other retailers.
 */
export async function loadRetailerPlugins(
  options: LoadRetailerPluginsOptions = {},
): Promise<LoadRetailerPluginsResult> {
  const registry = options.registry ?? retailerRegistry;
  const result: LoadRetailerPluginsResult = {
    pluginDir: "",
    loaded: 0,
    failed: 0,
    skipped: 0,
    statuses: [],
  };

  let discovery;
  try {
    discovery = await discoverPluginPackages({
      pluginDir: options.pluginDir,
      env: options.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: PluginStatusRecord = {
      packageName: "plugin-discovery",
      id: null,
      name: null,
      version: null,
      apiVersion: null,
      status: "FAILED",
      error: message,
      capabilities: [],
      supportedDomains: [],
    };
    remember(status);
    log.error({ err: error }, "retailer plugin discovery failed");
    result.pluginDir = options.pluginDir ?? "";
    result.failed += 1;
    result.statuses.push(status);
    return result;
  }

  result.pluginDir = discovery.pluginDir;

  if (discovery.packages.length === 0 && discovery.errors.length === 0) {
    log.info(
      { pluginDir: discovery.pluginDir },
      "no retailer plugins configured",
    );
    return result;
  }

  for (const error of discovery.errors) {
    const status = statusForDiscoveryError(error);
    remember(status);
    result.statuses.push(status);
    result.failed += 1;
    log.warn(
      {
        packageName: error.packageName,
        pluginId: error.id,
        error: error.message,
      },
      "retailer plugin could not be discovered",
    );
  }

  for (const descriptor of discovery.packages) {
    if (registry.has(descriptor.manifest.id)) {
      const status = statusForDescriptor(descriptor);
      status.status = "LOADED";
      remember(status);
      result.statuses.push(status);
      result.skipped += 1;
      log.debug(
        {
          packageName: descriptor.packageName,
          pluginId: descriptor.manifest.id,
          version: descriptor.version,
        },
        "retailer plugin already registered; skipping duplicate load",
      );
      continue;
    }

    try {
      const status = await loadDescriptor(descriptor, options, registry);
      remember(status);
      result.statuses.push(status);
      result.loaded += 1;
    } catch (error) {
      const secretValues = buildPluginConfig(
        descriptor.manifest,
        options.env ?? process.env,
      ).secretValues;
      const message = redactPluginSecrets(
        error instanceof Error ? error.message : String(error),
        secretValues,
      );
      const status = statusForDescriptor(descriptor);
      status.error = message;
      remember(status);
      result.statuses.push(status);
      result.failed += 1;
      log.error(
        {
          packageName: descriptor.packageName,
          pluginId: descriptor.manifest.id,
          pluginVersion: descriptor.version,
          error: message,
        },
        "retailer plugin failed to load",
      );
    }
  }

  log.info(
    {
      pluginDir: discovery.pluginDir,
      loaded: result.loaded,
      failed: result.failed,
      skipped: result.skipped,
    },
    "retailer plugin load complete",
  );
  return result;
}

/**
 * Idempotent application-wide loader. Boot code awaits this before serving
 * requests or starting workers.
 */
export function ensureRetailerPluginsLoaded(): Promise<LoadRetailerPluginsResult> {
  if (!loadPromise) {
    loadPromise = loadRetailerPlugins().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export function listPluginStatuses(): PluginStatusRecord[] {
  return [...statuses.values()].sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

export function getPluginStatus(
  retailerId: string,
): PluginStatusRecord | undefined {
  for (const status of statuses.values()) {
    if (status.id === retailerId) {
      return status;
    }
  }
  return undefined;
}

/** Test hook: clear the singleton load promise and status cache. */
export function resetRetailerPluginsForTests(): void {
  loadPromise = null;
  statuses.clear();
  loadedInstances.clear();
}

/** Gracefully dispose loaded plugin instances. */
export async function shutdownRetailerPlugins(): Promise<void> {
  const instances = [...loadedInstances.entries()];
  loadedInstances.clear();
  await Promise.all(
    instances.map(async ([id, instance]) => {
      try {
        await instance.dispose?.();
      } catch (error) {
        log.warn(
          { pluginId: id, err: error },
          "retailer plugin dispose failed",
        );
      }
    }),
  );
  loadPromise = null;
}
