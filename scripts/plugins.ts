import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { PluginLogger } from "@provmon/retailer-plugin-sdk";

import { buildPluginConfig } from "../src/modules/retailers/plugin/config";
import {
  discoverPluginPackages,
  resolvePluginDir,
  PLUGIN_LIST_FILE,
  type PluginDiscoveryResult,
} from "../src/modules/retailers/plugin/discovery";

const consoleLogger: PluginLogger = {
  debug(fields, message) {
    console.log("[debug]", message ?? "", fields);
  },
  info(fields, message) {
    console.log("[info]", message ?? "", fields);
  },
  warn(fields, message) {
    console.warn("[warn]", message ?? "", fields);
  },
  error(fields, message) {
    console.error("[error]", message ?? "", fields);
  },
};

function printDiscovery(result: PluginDiscoveryResult): void {
  console.log(`Plugin directory: ${result.pluginDir}`);
  if (result.packages.length === 0 && result.errors.length === 0) {
    console.log("No retailer plugins configured.");
    return;
  }

  for (const descriptor of result.packages) {
    const config = buildPluginConfig(descriptor.manifest, process.env);
    console.log(
      [
        `- ${descriptor.manifest.id}`,
        `package=${descriptor.packageName}`,
        `version=${descriptor.version}`,
        `api=${descriptor.manifest.apiVersion}`,
        `domains=${descriptor.manifest.supportedDomains.join(",")}`,
        `capabilities=${descriptor.manifest.capabilities.join(",")}`,
        `missingEnv=${config.missing.join(",") || "none"}`,
      ].join("  "),
    );
  }

  for (const error of result.errors) {
    console.error(`- ${error.packageName}: ${error.message}`);
  }
}

function findDuplicateIssues(result: PluginDiscoveryResult): string[] {
  const issues: string[] = [];
  const ids = new Map<string, string>();
  const domains = new Map<string, string>();

  for (const descriptor of result.packages) {
    const { id, supportedDomains } = descriptor.manifest;
    const existingId = ids.get(id);
    if (existingId) {
      issues.push(
        `Plugin id "${id}" is provided by both ${existingId} and ${descriptor.packageName}`,
      );
    } else {
      ids.set(id, descriptor.packageName);
    }

    for (const domain of supportedDomains) {
      const existingDomain = domains.get(domain);
      if (existingDomain) {
        issues.push(
          `Domain "${domain}" is claimed by both ${existingDomain} and ${descriptor.packageName}`,
        );
      } else {
        domains.set(domain, descriptor.packageName);
      }
    }
  }

  return issues;
}

async function listCommand(): Promise<number> {
  const result = await discoverPluginPackages();
  printDiscovery(result);
  return result.errors.length > 0 ? 1 : 0;
}

async function validateCommand(): Promise<number> {
  const discovery = await discoverPluginPackages();
  printDiscovery(discovery);

  const issues = findDuplicateIssues(discovery);
  for (const issue of issues) {
    console.error(`error: ${issue}`);
  }

  if (discovery.errors.length > 0) {
    return 1;
  }

  // Give the environment module placeholder values so the CLI can import
  // the loader and validate plugin code/config without a live database.
  process.env.DATABASE_URL ||= "postgresql://plugins-cli.invalid/provmon";
  process.env.REDIS_URL ||= "redis://plugins-cli.invalid:6379";
  process.env.AUTH_SECRET ||= "plugins-cli-placeholder-secret";

  const [{ loadRetailerPlugins }, { RetailerRegistry }] = await Promise.all([
    import("../src/modules/retailers/plugin/loader"),
    import("../src/modules/retailers/core/retailer-registry"),
  ]);

  const registry = new RetailerRegistry();
  const result = await loadRetailerPlugins({
    registry,
    pluginDir: discovery.pluginDir,
    pluginLogger: () => consoleLogger,
  });

  console.log(
    `Validated ${result.loaded + result.skipped} plugin(s); ${result.failed} failed.`,
  );
  return result.failed > 0 || issues.length > 0 ? 1 : 0;
}

function ensurePluginDir(pluginDir: string): void {
  mkdirSync(pluginDir, { recursive: true });
  const packageJsonPath = path.join(pluginDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ private: true, dependencies: {} }, null, 2) + "\n",
    );
  }
}

function linkLocalCommand(args: string[]): number {
  const pluginDir = resolvePluginDir();
  ensurePluginDir(pluginDir);

  let candidates = args;
  if (candidates.length === 0) {
    const siblingPackages = path.resolve("../provmon-retailers/packages");
    if (existsSync(siblingPackages)) {
      candidates = readdirSync(siblingPackages, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(
              path.join(siblingPackages, entry.name, "provmon.plugin.json"),
            ),
        )
        .map((entry) => path.join(siblingPackages, entry.name));
    }
  }
  if (candidates.length === 0) {
    console.error(
      "Provide one or more local plugin package paths, or check out a sibling provmon-retailers repository.",
    );
    return 1;
  }

  const resolved = candidates.map((candidate) => path.resolve(candidate));
  const missing = resolved.filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    console.error("Plugin package paths not found:");
    for (const candidate of missing) {
      console.error(`  - ${candidate}`);
    }
    return 1;
  }

  const install = spawnSync("npm", ["install", "--prefix", pluginDir, ...resolved], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    return install.status ?? 1;
  }

  const packageNames: string[] = [];
  for (const candidate of resolved) {
    const packageJson = JSON.parse(
      readFileSync(path.join(candidate, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (typeof packageJson.name === "string") {
      packageNames.push(packageJson.name);
    }
  }

  const listPath = path.join(pluginDir, PLUGIN_LIST_FILE);
  let existing: { plugins?: string[] } = {};
  if (existsSync(listPath)) {
    existing = JSON.parse(readFileSync(listPath, "utf8")) as {
      plugins?: string[];
    };
  }
  const plugins = [...new Set([...(existing.plugins ?? []), ...packageNames])];
  writeFileSync(
    listPath,
    JSON.stringify({ plugins }, null, 2) + "\n",
  );
  console.log(`Linked ${plugins.length} plugin(s) in ${pluginDir}.`);
  return 0;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let exitCode: number;
  switch (command) {
    case "list":
      exitCode = await listCommand();
      break;
    case "validate":
      exitCode = await validateCommand();
      break;
    case "link-local":
      exitCode = linkLocalCommand(args);
      break;
    default:
      console.error(
        "Usage: tsx scripts/plugins.ts <list|validate|link-local> [paths...]",
      );
      exitCode = 1;
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
