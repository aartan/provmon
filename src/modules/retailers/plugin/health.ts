import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";

const log = logger.child({ component: "retailer-plugins" });

/**
 * Warn when persisted catalogue data references a retailer whose plugin is
 * not installed. This is common during the migration from built-in
 * adapters, and the warning gives operators an actionable next step.
 */
export async function warnAboutMissingRetailerPlugins(): Promise<string[]> {
  try {
    const [listingRetailers, catalogueRetailers] = await Promise.all([
      db.retailerListing.findMany({
        distinct: ["retailerId"],
        select: { retailerId: true },
      }),
      db.retailerCatalogue.findMany({
        select: { retailerId: true },
      }),
    ]);

    const ids = new Set<string>([
      ...listingRetailers.map((row) => row.retailerId),
      ...catalogueRetailers.map((row) => row.retailerId),
    ]);
    const missing = [...ids]
      .filter((id) => !retailerRegistry.has(id))
      .sort((left, right) => left.localeCompare(right));

    if (missing.length > 0) {
      log.warn(
        {
          retailerIds: missing,
          pluginDir: process.env.PROVMON_PLUGIN_DIR || "plugins",
        },
        "catalogue rows exist for retailers without a loaded plugin; install and configure the matching plugin packages",
      );
    }

    return missing;
  } catch (error) {
    log.warn(
      { err: error },
      "could not check for retailer ids without a loaded plugin",
    );
    return [];
  }
}
