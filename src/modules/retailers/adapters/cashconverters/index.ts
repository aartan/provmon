import { CashConvertersAdapter } from "@/modules/retailers/adapters/cashconverters/adapter";

export { CashConvertersAdapter } from "@/modules/retailers/adapters/cashconverters/adapter";
export {
  CASHCONVERTERS_DOMAIN,
  CASHCONVERTERS_SITE_URL,
  extractProductCode,
  parseCashConvertersUrl,
  parseProductListItem,
} from "@/modules/retailers/adapters/cashconverters/parser";
export * from "@/modules/retailers/adapters/cashconverters/schemas";

/**
 * Built-in Cash Converters adapter. Registered in
 * `src/modules/retailers/adapters/index.ts`; constructed with defaults
 * (real fetch, production API URL) for the worker and preview flows.
 */
export const cashConvertersRetailer = new CashConvertersAdapter();
