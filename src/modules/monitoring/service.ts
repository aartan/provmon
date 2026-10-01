
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { productDetailsSchema } from "@/modules/retailers/core/schemas";
import {
  isRetailerError,
  UnsupportedRetailerError,
} from "@/modules/retailers/core/errors";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  findOrCreateProduct,
  markProductChecked,
  updateProductFromCheck,
} from "@/modules/products/product.repository";
import {
  createSubscription,
  findSubscription,
  recordCheck,
} from "@/modules/monitoring/repository";
import { handleCheckOutcome } from "@/modules/notifications/notification.service";
import {
  createSubscriptionSchema,
  requiresTargetPrice,
} from "@/modules/monitoring/schemas";
import {
  type CheckJobData,
  type CheckOutcome,
  INTERVAL_OPTIONS_MINUTES,
  type MonitoringCondition,
} from "@/modules/monitoring/types";

/** User-facing service error (as opposed to internal/adapter errors). */
export class MonitoringServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitoringServiceError";
  }
}

/** Interval options (minutes) allowed for a retailer id. */
export function intervalOptionsForRetailer(retailerId: string): number[] {
  registerBuiltInAdapters();
  const adapter = retailerRegistry.getById(retailerId);
  const floorMs = adapter?.minCheckIntervalMs ?? 60_000;
  return INTERVAL_OPTIONS_MINUTES.filter((minutes) => minutes * 60_000 >= floorMs);
}

export interface AddMonitoringSubscriptionInput {
  userId: string;
  url: string;
  targetPriceMinor?: number;
  condition: MonitoringCondition;
  intervalMinutes: number;
}

/**
 * Full add-product flow: resolve the retailer from the URL, fetch current
 * product details through the adapter, persist the shared product, and
 * create the user's monitoring subscription.
 */
export async function addMonitoringSubscription(
  input: AddMonitoringSubscriptionInput,
) {
  registerBuiltInAdapters();

  let adapter;
  let parsed;
  try {
    ({ adapter, parsed } = resolveRetailerUrl(input.url));
  } catch (error) {
    if (error instanceof UnsupportedRetailerError) {
      throw new MonitoringServiceError(
        "This retailer is not supported yet. Please check the URL and try again.",
      );
    }
    if (isRetailerError(error)) {
      throw new MonitoringServiceError(
        `This URL does not look like a valid product URL: ${error.message}`,
      );
    }
    throw error;
  }

  // Validate configuration before touching the retailer or the database.
  const validated = createSubscriptionSchema.safeParse({
    productId: "placeholder", // validated separately below
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
  });
  if (!validated.success) {
    throw new MonitoringServiceError(
      validated.error.issues.map((i) => i.message).join("; "),
    );
  }
  if (requiresTargetPrice(input.condition) && input.targetPriceMinor === undefined) {
    throw new MonitoringServiceError(
      "A target price is required for price monitoring",
    );
  }
  const floorMinutes = Math.ceil(adapter.minCheckIntervalMs / 60_000);
  if (input.intervalMinutes * 60_000 < adapter.minCheckIntervalMs) {
    throw new MonitoringServiceError(
      `${adapter.name} does not allow checking more often than every ${floorMinutes} minutes`,
    );
  }

  // Fetch and validate product details through the adapter.
  let details;
  try {
    details = await adapter.getProduct(parsed.url);
  } catch (error) {
    if (isRetailerError(error)) {
      throw new MonitoringServiceError(
        `Could not load the product from ${adapter.name}: ${error.message}`,
      );
    }
    throw error;
  }
  const parsedDetails = productDetailsSchema.safeParse(details);
  if (!parsedDetails.success) {
    logger.error(
      { component: "monitoring", retailerId: adapter.id, issues: parsedDetails.error.issues },
      "adapter returned invalid product details",
    );
    throw new MonitoringServiceError(
      `Could not load the product from ${adapter.name} (invalid data)`,
    );
  }

  const product = await findOrCreateProduct(parsedDetails.data);

  const existing = await db.monitoringSubscription.findUnique({
    where: { userId_productId: { userId: input.userId, productId: product.id } },
  });
  if (existing) {
    throw new MonitoringServiceError("You are already monitoring this product");
  }

  return createSubscription({
    userId: input.userId,
    productId: product.id,
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    initialAvailability: parsedDetails.data.availability,
  });
}

/**
 * Execute a single check for a subscription. This is the engine's hot
 * path: it only talks to retailers through the adapter interface.
 *
 * Error policy:
 *  - retryable retailer errors: an ERROR check row is recorded and the
 *    error is rethrown so BullMQ retries with exponential backoff.
 *  - non-retryable errors (blocked, parse, product-not-found): an ERROR
 *    row is recorded and the job completes — no pointless retries.
 *  - one failing check never affects other checks.
 */
export async function processCheckJob(data: CheckJobData): Promise<CheckOutcome> {
  const startedAt = Date.now();
  registerBuiltInAdapters();

  const subscription = await findSubscription(data.subscriptionId);
  if (!subscription) {
    logger.warn(
      { component: "monitoring", subscriptionId: data.subscriptionId },
      "check job for missing subscription; skipping",
    );
    return {
      subscriptionId: data.subscriptionId,
      productId: "",
      previous: { availability: "UNKNOWN", priceMinor: null },
      current: { availability: "UNKNOWN", priceMinor: null },
      success: false,
      errorCode: "SUBSCRIPTION_NOT_FOUND",
    };
  }

  const { product } = subscription;
  const previous = {
    availability: product.currentAvailability,
    priceMinor: product.currentPriceMinor,
  };

  const adapter = retailerRegistry.getById(product.retailerId);
  if (!adapter) {
    const error = `No adapter registered for retailer "${product.retailerId}"`;
    logger.error({ component: "monitoring", subscriptionId: subscription.id }, error);
    await recordCheck({
      subscriptionId: subscription.id,
      productId: product.id,
      status: "ERROR",
      errorCode: "ADAPTER_MISSING",
      errorMessage: error,
      durationMs: Date.now() - startedAt,
    });
    return {
      subscriptionId: subscription.id,
      productId: product.id,
      previous,
      current: previous,
      success: false,
      errorCode: "ADAPTER_MISSING",
    };
  }

  try {
    const rawDetails = await adapter.getProduct(product.url);
    const validated = productDetailsSchema.safeParse(rawDetails);
    if (!validated.success) {
      logger.error(
        { component: "monitoring", retailerId: adapter.id, issues: validated.error.issues },
        "adapter returned invalid product details during check",
      );
      await recordCheck({
        subscriptionId: subscription.id,
        productId: product.id,
        status: "ERROR",
        errorCode: "PARSE",
        errorMessage: "Adapter returned invalid product details",
        durationMs: Date.now() - startedAt,
      });
      return {
        subscriptionId: subscription.id,
        productId: product.id,
        previous,
        current: previous,
        success: false,
        errorCode: "PARSE",
      };
    }

    const details = validated.data;
    await updateProductFromCheck(product.id, details);
    await recordCheck({
      subscriptionId: subscription.id,
      productId: product.id,
      status: "SUCCESS",
      availability: details.availability,
      priceMinor: details.priceMinor ?? null,
      durationMs: Date.now() - startedAt,
    });

    const outcome: CheckOutcome = {
      subscriptionId: subscription.id,
      productId: product.id,
      previous,
      current: {
        availability: details.availability,
        priceMinor: details.priceMinor ?? null,
      },
      success: true,
    };

    // Notification evaluation must never fail the check itself.
    try {
      await handleCheckOutcome(subscription.id, outcome);
    } catch (error) {
      logger.error(
        { component: "monitoring", subscriptionId: subscription.id, err: error },
        "notification evaluation failed",
      );
    }

    return outcome;
  } catch (error) {
    if (isRetailerError(error)) {
      logger.warn(
        {
          component: "monitoring",
          subscriptionId: subscription.id,
          retailerId: adapter.id,
          code: error.code,
          retryable: error.retryable,
        },
        "retailer check failed",
      );
      await markProductChecked(product.id);
      await recordCheck({
        subscriptionId: subscription.id,
        productId: product.id,
        status: "ERROR",
        errorCode: error.code,
        errorMessage: error.message,
        durationMs: Date.now() - startedAt,
      });
      if (error.retryable) {
        throw error; // BullMQ retries with exponential backoff.
      }
      return {
        subscriptionId: subscription.id,
        productId: product.id,
        previous,
        current: previous,
        success: false,
        errorCode: error.code,
      };
    }

    logger.error(
      { component: "monitoring", subscriptionId: subscription.id, err: error },
      "unexpected error during check",
    );
    await markProductChecked(product.id);
    await recordCheck({
      subscriptionId: subscription.id,
      productId: product.id,
      status: "ERROR",
      errorCode: "UNKNOWN",
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/** Re-exported for convenience of API callers. */
export { UnsupportedRetailerError };
