import { createRequire } from "node:module";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  hasPluginCapability,
  validateRetailerPluginManifest,
  type RetailerPluginManifest,
} from "@provmon/retailer-plugin-sdk";

/**
 * Static plugin discovery. This module reads manifests and resolves entry
 * points without importing plugin code, so the core registry can be built
 * synchronously-ish before any retailer module is executed.
 */

export const PLUGIN_MANIFEST_FILE = "provmon.plugin.json";
export const PLUGIN_LIST_FILE = "provmon.plugins.json";
export const DEFAULT_PLUGIN_DIR = "plugins";

const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const pluginListSchema = z.object({
  plugins: z.array(z.string().min(1)).default([]),
});

export interface PluginPackageDescriptor {
  packageName: string;
  packageRoot: string;
  version: string;
  manifest: RetailerPluginManifest;
  entryPath: string;
}

export interface PluginDiscoveryError {
  packageName: string;
  message: string;
  id?: string;
  name?: string;
  version?: string;
  apiVersion?: number;
  capabilities?: string[];
  supportedDomains?: string[];
}

export interface PluginDiscoveryResult {
  pluginDir: string;
  packages: PluginPackageDescriptor[];
  errors: PluginDiscoveryError[];
}

export interface DiscoverPluginPackagesOptions {
  pluginDir?: string;
  env?: Record<string, string | undefined>;
}

export function resolvePluginDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.resolve(
    /* turbopackIgnore: true */
    env.PROVMON_PLUGIN_DIR?.trim() || DEFAULT_PLUGIN_DIR,
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(target: string): Promise<unknown> {
  const text = await readFile(target, "utf8");
  return JSON.parse(text) as unknown;
}

async function readPluginPackageNames(
  pluginDir: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const override = env.PROVMON_PLUGINS?.trim();
  if (override) {
    return override
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  const listPath = path.join(pluginDir, PLUGIN_LIST_FILE);
  if (await pathExists(listPath)) {
    const parsed = pluginListSchema.safeParse(await readJsonFile(listPath));
    if (!parsed.success) {
      throw new Error(
        `Invalid ${PLUGIN_LIST_FILE}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data.plugins;
  }

  // Fallback for development: direct package directories under the plugin
  // directory. npm-installed packages should use provmon.plugins.json.
  const entries = await readdir(pluginDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const candidate = path.join(pluginDir, entry.name);
    if (await pathExists(path.join(candidate, PLUGIN_MANIFEST_FILE))) {
      names.push(`./${entry.name}`);
    }
  }
  return names;
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
}

async function findPackageRootFromEntry(
  entryPath: string,
): Promise<string | undefined> {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 8; depth += 1) {
    if (await pathExists(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

async function resolvePackageRoot(
  pluginDir: string,
  packageName: string,
): Promise<{ packageRoot: string; packageJson: PackageJson }> {
  const isPathLike =
    packageName.startsWith(".") ||
    path.isAbsolute(packageName) ||
    packageName.includes("\\");

  if (isPathLike) {
    const packageRoot = path.resolve(pluginDir, packageName);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!(await pathExists(packageJsonPath))) {
      throw new Error(`No package.json found at ${packageRoot}`);
    }
    return {
      packageRoot,
      packageJson: (await readJsonFile(packageJsonPath)) as PackageJson,
    };
  }

  const requireFromPlugins = createRequire(
    path.join(pluginDir, "package.json"),
  );
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromPlugins.resolve(`${packageName}/package.json`);
  } catch {
    // The package may hide package.json behind an exports map. Resolve the
    // entry point and walk up to its package root instead.
    const entryPath = requireFromPlugins.resolve(packageName);
    const packageRoot = await findPackageRootFromEntry(entryPath);
    if (!packageRoot) {
      throw new Error(`Could not find package root for ${packageName}`);
    }
    return {
      packageRoot,
      packageJson: (await readJsonFile(
        path.join(packageRoot, "package.json"),
      )) as PackageJson,
    };
  }

  return {
    packageRoot: path.dirname(packageJsonPath),
    packageJson: (await readJsonFile(packageJsonPath)) as PackageJson,
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function resolvePackage(
  pluginDir: string,
  packageName: string,
): Promise<PluginPackageDescriptor> {
  const { packageRoot, packageJson } = await resolvePackageRoot(
    pluginDir,
    packageName,
  );

  if (typeof packageJson.version !== "string" ||
      !PACKAGE_VERSION_PATTERN.test(packageJson.version)) {
    throw new Error(
      `Package ${packageName} has a missing or invalid semver version`,
    );
  }

  const manifestPath = path.join(packageRoot, PLUGIN_MANIFEST_FILE);
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Missing ${PLUGIN_MANIFEST_FILE} in ${packageRoot}`);
  }

  const manifest = validateRetailerPluginManifest(
    await readJsonFile(manifestPath),
  );

  if (!hasPluginCapability(manifest, "url-monitoring")) {
    throw new Error(
      `Plugin ${manifest.id} must declare the "url-monitoring" capability`,
    );
  }

  const entryPath = path.resolve(packageRoot, manifest.entry);
  if (!isInside(packageRoot, entryPath)) {
    throw new Error(
      `Plugin ${manifest.id} entry must stay inside its package: ${manifest.entry}`,
    );
  }
  if (!(await pathExists(entryPath))) {
    throw new Error(`Plugin ${manifest.id} entry not found: ${entryPath}`);
  }

  return {
    packageName,
    packageRoot,
    version: packageJson.version,
    manifest,
    entryPath,
  };
}

/**
 * Discover all configured plugin packages. Never throws for a single bad
 * plugin: failures are returned alongside the valid descriptors so the
 * application can start and surface the error in the plugin status view.
 */
export async function discoverPluginPackages(
  options: DiscoverPluginPackagesOptions = {},
): Promise<PluginDiscoveryResult> {
  const env = options.env ?? process.env;
  const pluginDir = options.pluginDir
    ? path.resolve(/* turbopackIgnore: true */ options.pluginDir)
    : resolvePluginDir(env);

  const result: PluginDiscoveryResult = {
    pluginDir,
    packages: [],
    errors: [],
  };

  if (!(await pathExists(pluginDir))) {
    return result;
  }

  let packageNames: string[];
  try {
    packageNames = await readPluginPackageNames(pluginDir, env);
  } catch (error) {
    result.errors.push({
      packageName: PLUGIN_LIST_FILE,
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  const seenPackageNames = new Set<string>();
  for (const packageName of packageNames) {
    if (seenPackageNames.has(packageName)) {
      result.errors.push({
        packageName,
        message: `Plugin package "${packageName}" is listed more than once`,
      });
      continue;
    }
    seenPackageNames.add(packageName);

    try {
      result.packages.push(await resolvePackage(pluginDir, packageName));
    } catch (error) {
      result.errors.push({
        packageName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
