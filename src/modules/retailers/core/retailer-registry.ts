import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Normalise a hostname for matching: lowercase, no trailing dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True when `hostname` equals `supported` or is a subdomain of it:
 * "www.shop.example" matches "shop.example", while
 * "fakeshop.example" does not.
 */
export function hostnameMatches(hostname: string, supported: string): boolean {
  const host = normalizeHostname(hostname);
  const domain = normalizeHostname(supported);
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Registry of retailer adapters. External plugins are loaded and
 * registered by `ensureRetailerPluginsLoaded()`; tests may register an
 * in-process fixture directly. The monitoring engine, catalogue importer
 * and resolver look adapters up here and never import retailer code.
 */
export class RetailerRegistry {
  private readonly adaptersById = new Map<string, RetailerAdapter>();

  register(adapter: RetailerAdapter): void {
    if (!ADAPTER_ID_PATTERN.test(adapter.id)) {
      throw new Error(
        `Invalid retailer adapter id "${adapter.id}": must match ${ADAPTER_ID_PATTERN}`,
      );
    }
    if (adapter.supportedDomains.length === 0) {
      throw new Error(`Retailer adapter "${adapter.id}" has no supported domains`);
    }
    for (const domain of adapter.supportedDomains) {
      if (domain.includes("://") || domain.includes("/")) {
        throw new Error(
          `Retailer adapter "${adapter.id}" has an invalid supported domain "${domain}"`,
        );
      }
    }

    const existingById = this.adaptersById.get(adapter.id);
    if (existingById) {
      if (existingById === adapter) {
        return; // Idempotent re-registration (e.g. built-in registration helper).
      }
      throw new Error(`Retailer adapter id "${adapter.id}" is already registered`);
    }

    for (const [id, other] of this.adaptersById) {
      for (const domain of adapter.supportedDomains) {
        if (other.supportedDomains.some((d) => d === domain)) {
          throw new Error(
            `Domain "${domain}" is already claimed by retailer adapter "${id}"`,
          );
        }
      }
    }

    this.adaptersById.set(adapter.id, adapter);
  }

  getById(id: string): RetailerAdapter | undefined {
    return this.adaptersById.get(id);
  }

  getByDomain(hostname: string): RetailerAdapter | undefined {
    for (const adapter of this.adaptersById.values()) {
      if (adapter.supportedDomains.some((domain) => hostnameMatches(hostname, domain))) {
        return adapter;
      }
    }
    return undefined;
  }

  has(id: string): boolean {
    return this.adaptersById.has(id);
  }

  list(): RetailerAdapter[] {
    return [...this.adaptersById.values()];
  }
}

/**
 * Shared registry instance for the application. Configured plugins are
 * registered by `ensureRetailerPluginsLoaded()`, which is idempotent and
 * safe to call from the web process and the worker.
 */
export const retailerRegistry = new RetailerRegistry();
