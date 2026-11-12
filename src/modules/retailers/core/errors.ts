/**
 * Retailer error taxonomy. The canonical error classes and codes live in
 * `@provmon/retailer-plugin-sdk` so external plugins throw the exact same
 * errors core understands.
 */

export {
  InvalidProductUrlError,
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
  isRetailerError,
  type RetailerErrorCode,
} from "@provmon/retailer-plugin-sdk";

/**
 * Raised by the resolver when no registered adapter claims the URL's
 * domain. Not a RetailerError: no retailer was involved.
 */
export class UnsupportedRetailerError extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(`No retailer adapter supports this domain: ${hostname}`);
    this.name = "UnsupportedRetailerError";
    this.hostname = hostname;
  }
}
