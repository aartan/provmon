import { CeXAdapter } from "@/modules/retailers/adapters/cex/adapter";

export { CeXAdapter } from "@/modules/retailers/adapters/cex/adapter";
export {
  CEX_DOMAIN,
  CEX_SITE_URL,
  canonicalProductUrl,
  extractBoxId,
  normalizeImageUrl,
  parseCeXUrl,
  parseProductHit,
} from "@/modules/retailers/adapters/cex/parser";
export * from "@/modules/retailers/adapters/cex/schemas";

/**
 * Built-in CeX adapter. Registered in
 * `src/modules/retailers/adapters/index.ts`; constructed with defaults
 * (real fetch, production API URL and public search credentials) for the
 * worker and preview flows.
 */
export const cexRetailer = new CeXAdapter();
