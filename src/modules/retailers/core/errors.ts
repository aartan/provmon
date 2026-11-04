/**
 * Retailer error taxonomy. Every failure mode a retailer can produce is
 * mapped to a stable code with a `retryable` flag so the monitoring engine
 * can decide how to respond without knowing anything about the retailer.
 */

export type RetailerErrorCode =
  | "INVALID_URL"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "BLOCKED"
  | "PARSE"
  | "PRODUCT_NOT_FOUND";

const RETRYABLE_CODES: ReadonlySet<RetailerErrorCode> = new Set([
  "NETWORK",
  "TIMEOUT",
  "RATE_LIMITED",
]);

export class RetailerError extends Error {
  readonly code: RetailerErrorCode;
  readonly retryable: boolean;
  readonly retailerId: string;
  readonly cause?: unknown;

  constructor(opts: {
    retailerId: string;
    code: RetailerErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(`${opts.retailerId}: ${opts.message}`);
    this.name = "RetailerError";
    this.retailerId = opts.retailerId;
    this.code = opts.code;
    this.retryable = RETRYABLE_CODES.has(opts.code);
    this.cause = opts.cause;
  }
}

/** The URL does not point at a product this adapter can handle. */
export class InvalidProductUrlError extends RetailerError {
  constructor(retailerId: string, url: string) {
    super({ retailerId, code: "INVALID_URL", message: `Not a valid product URL: ${url}` });
    this.name = "InvalidProductUrlError";
  }
}

/** The product no longer exists (sold out permanently, delisted). */
export class ProductNotFoundError extends RetailerError {
  constructor(retailerId: string, retailerProductId?: string) {
    super({
      retailerId,
      code: "PRODUCT_NOT_FOUND",
      message: retailerProductId
        ? `Product not found: ${retailerProductId}`
        : "Product not found",
    });
    this.name = "ProductNotFoundError";
  }
}

export class RetailerNetworkError extends RetailerError {
  constructor(retailerId: string, cause?: unknown) {
    super({ retailerId, code: "NETWORK", message: "Network request failed", cause });
    this.name = "RetailerNetworkError";
  }
}

export class RetailerTimeoutError extends RetailerError {
  constructor(retailerId: string, cause?: unknown) {
    super({ retailerId, code: "TIMEOUT", message: "Request timed out", cause });
    this.name = "RetailerTimeoutError";
  }
}

export class RetailerRateLimitedError extends RetailerError {
  /** Server-provided Retry-After duration, when present. */
  readonly retryAfterMs?: number;

  constructor(retailerId: string, cause?: unknown, retryAfterMs?: number) {
    super({ retailerId, code: "RATE_LIMITED", message: "Rate limited by retailer", cause });
    this.name = "RetailerRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class RetailerBlockedError extends RetailerError {
  constructor(retailerId: string, cause?: unknown) {
    super({
      retailerId,
      code: "BLOCKED",
      message: "Request blocked by retailer (anti-bot protection)",
      cause,
    });
    this.name = "RetailerBlockedError";
  }
}

export class RetailerParseError extends RetailerError {
  constructor(retailerId: string, cause?: unknown) {
    super({
      retailerId,
      code: "PARSE",
      message: "Could not parse retailer response",
      cause,
    });
    this.name = "RetailerParseError";
  }
}

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

export function isRetailerError(error: unknown): error is RetailerError {
  return error instanceof RetailerError;
}
