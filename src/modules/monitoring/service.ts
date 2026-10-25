import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { productDetailsSchema } from "@/modules/retailers/core/schemas";
import {
  isRetailerError,
  UnsupportedRetailerError,
} from "@/modules/retailers/core/errors";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  findOrCreateListing,
  markListingChecked,
  updateListingFromCheck,
  type ListingCheckState,
} from "@/modules/catalogue/catalogue.repository";
import {
  fetchProductDetails,
  ProductFetchError,
  resolveProductUrl,
} from "@/modules/catalogue/product-fetch";
import { evaluateInventoryAlertsForListing } from "@/modules/alerts/alert.service";
import {
  createSubscription,
  findSubscription,
  recordCheck,
  updateSubscription,
} from "@/modules/monitoring/repository";
import { handleCheckOutcome } from "@/modules/notifications/notification.service";
import {
  createSubscriptionSchema,
  requiresTargetPrice,
} from "@/modules/monitoring/schemas";
import {
  type CheckJobData,
  type CheckOutcome,
  type SingleCheckJobData,
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
  /** Defaults to SNAPSHOT_INTERVAL_MINUTES or daily. 0 disables snapshots. */
  snapshotIntervalMinutes?: number;
}

/**
 * Full add-product flow: resolve the retailer from the URL, fetch current
 * product details through the adapter, persist the shared product, and
 * create the user's monitoring subscription.
 */
export async function addMonitoringSubscription(
  input: AddMonitoringSubscriptionInput,
) {
  // Resolve the adapter before validation so the retailer's interval floor
  // can be checked without contacting the retailer.
  let resolved;
  try {
    resolved = resolveProductUrl(input.url);
  } catch (error) {
    if (error instanceof ProductFetchError) {
      throw new MonitoringServiceError(error.message);
    }
    throw error;
  }
  const { adapter } = resolved;

  // Validate configuration before touching the retailer or the database.
  const validated = createSubscriptionSchema.safeParse({
    retailerListingId: "placeholder", // validated separately below
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    snapshotIntervalMinutes: input.snapshotIntervalMinutes,
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

  let details;
  try {
    details = await fetchProductDetails(adapter, resolved.url);
  } catch (error) {
    if (error instanceof ProductFetchError) {
      throw new MonitoringServiceError(error.message);
    }
    throw error;
  }

  const listing = await findOrCreateListing(details);

  const existing = await db.monitoringSubscription.findUnique({
    where: {
      userId_retailerListingId: {
        userId: input.userId,
        retailerListingId: listing.id,
      },
    },
  });
  if (existing) {
    // Re-adding an archived subscription resumes it rather than failing the
    // unique constraint. Active/paused subscriptions remain a conflict.
    if (existing.status === "ARCHIVED") {
      const resumed = await updateSubscription(existing.id, input.userId, {
        status: "ACTIVE",
        condition: input.condition,
        targetPriceMinor: input.targetPriceMinor ?? null,
        intervalMinutes: input.intervalMinutes,
        snapshotIntervalMinutes: input.snapshotIntervalMinutes,
      });
      if (!resumed) {
        throw new MonitoringServiceError("Could not resume monitoring");
      }
      return resumed;
    }
    throw new MonitoringServiceError("You are already monitoring this product");
  }

  return createSubscription({
    userId: input.userId,
    retailerListingId: listing.id,
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    snapshotIntervalMinutes: input.snapshotIntervalMinutes,
    initialAvailability: details.availability,
  });
}

type CheckSubscriptionStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

interface CheckSubscription {
  id: string;
  retailerListingId: string;
  condition: MonitoringCondition;
  targetPriceMinor: number | null;
  intervalMinutes: number;
  snapshotIntervalMinutes: number;
  status: CheckSubscriptionStatus;
}

interface ListingStateRow {
  currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  currentPriceMinor: number | null;
}

function stateFromListing(listing: ListingStateRow): ListingCheckState {
  return {
    availability: listing.currentAvailability,
    priceMinor: listing.currentPriceMinor,
  };
}

/**
 * Load every active subscription for a shared listing, plus the explicitly
 * requested subscription when a direct/manual check is in progress. The
 * subscription list drives user-specific notification evaluation.
 */
async function loadSubscriptionsForCheck(
  retailerListingId: string,
  includeSubscriptionId?: string,
): Promise<CheckSubscription[]> {
  return db.monitoringSubscription.findMany({
    where: includeSubscriptionId
      ? {
          retailerListingId,
          OR: [{ status: "ACTIVE" }, { id: includeSubscriptionId }],
        }
      : { retailerListingId, status: "ACTIVE" },
    select: {
      id: true,
      retailerListingId: true,
      condition: true,
      targetPriceMinor: true,
      intervalMinutes: true,
      snapshotIntervalMinutes: true,
      status: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Atomically claim the shared listing check lease. Returns false when
 * another worker is already checking the same retailer listing.
 */
async function claimListingCheck(retailerListingId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "retailer_listings"
    SET "check_lease_until" = now() + interval '2 minutes'
    WHERE "id" = ${retailerListingId}
      AND ("check_lease_until" IS NULL OR "check_lease_until" < now())
    RETURNING "id"
  `;
  return rows.length === 1;
}

async function releaseListingCheck(retailerListingId: string): Promise<void> {
  try {
    await db.retailerListing.update({
      where: { id: retailerListingId },
      data: { checkLeaseUntil: null },
    });
  } catch (error) {
    logger.warn(
      { component: "monitoring", retailerListingId, err: error },
      "could not release shared-listing check lease",
    );
  }
}

function buildOutcome(
  subscription: CheckSubscription,
  previous: ListingCheckState,
  current: ListingCheckState,
  success: boolean,
  errorCode?: string,
): CheckOutcome {
  return {
    subscriptionId: subscription.id,
    retailerListingId: subscription.retailerListingId,
    previous,
    current,
    success,
    errorCode,
  };
}

/**
 * Historical alert failures must never fail the shared check. Delivery and
 * state updates are isolated per inventory rule inside the alert service.
 */
async function evaluateInventoryAlertsSafely(
  retailerListingId: string,
  checkedAt: Date | undefined,
): Promise<void> {
  try {
    await evaluateInventoryAlertsForListing(
      retailerListingId,
      checkedAt ?? new Date(),
    );
  } catch (error) {
    logger.error(
      { component: "monitoring", retailerListingId, err: error },
      "historical alert evaluation failed",
    );
  }
}

/**
 * Record a successful check for every active subscription and evaluate
 * notifications per user. Notification rules read that subscription's own
 * condition, target price, and dedup state, so shared check results never
 * leak between users.
 */
async function fanOutSuccess(
  subscriptions: CheckSubscription[],
  previous: ListingCheckState,
  current: ListingCheckState,
  startedAt: number,
): Promise<Map<string, CheckOutcome>> {  const outcomes = new Map<string, CheckOutcome>();

  for (const subscription of subscriptions) {
    try {
      await recordCheck({
        subscriptionId: subscription.id,
        retailerListingId: subscription.retailerListingId,
        status: "SUCCESS",
        availability: current.availability,
        priceMinor: current.priceMinor,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error(
        { component: "monitoring", subscriptionId: subscription.id, err: error },
        "could not record check; continuing with notifications",
      );
    }

    const outcome = buildOutcome(
      subscription,
      previous,
      current,
      true,
    );
    outcomes.set(subscription.id, outcome);

    try {
      await handleCheckOutcome(subscription.id, outcome);
    } catch (error) {
      logger.error(
        { component: "monitoring", subscriptionId: subscription.id, err: error },
        "notification evaluation failed",
      );
    }
  }

  return outcomes;
}

/** Record an error check for every affected subscription. No notifications. */
async function fanOutError(
  subscriptions: CheckSubscription[],
  current: ListingCheckState,
  errorCode: string,
  errorMessage: string,
  startedAt: number,
): Promise<Map<string, CheckOutcome>> {
  const outcomes = new Map<string, CheckOutcome>();

  for (const subscription of subscriptions) {
    try {
      await recordCheck({
        subscriptionId: subscription.id,
        retailerListingId: subscription.retailerListingId,
        status: "ERROR",
        errorCode,
        errorMessage,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error(
        { component: "monitoring", subscriptionId: subscription.id, err: error },
        "could not record failed check",
      );
    }
    outcomes.set(
      subscription.id,
      buildOutcome(subscription, current, current, false, errorCode),
    );
  }

  return outcomes;
}

/**
 * Align every active subscription with the check that just ran. This keeps
 * one shared listing on a single check schedule instead of letting each
 * user's interval enqueue a separate retailer request.
 */
async function advanceSubscriptionSchedules(
  subscriptions: CheckSubscription[],
): Promise<void> {
  const active = subscriptions.filter(
    (subscription) => subscription.status === "ACTIVE",
  );
  if (active.length === 0) {
    return;
  }

  const now = Date.now();
  const results = await Promise.allSettled(
    active.map((subscription) =>
      db.monitoringSubscription.update({
        where: { id: subscription.id },
        data: {
          nextCheckAt: new Date(
            now + subscription.intervalMinutes * 60_000,
          ),
        },
      }),
    ),
  );

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn(
        {
          component: "monitoring",
          subscriptionId: active[index].id,
          err: result.reason,
        },
        "could not advance subscription schedule",
      );
    }
  }
}

function minPositiveSnapshotInterval(
  subscriptions: CheckSubscription[],
): number {
  const interval = subscriptions.reduce((minimum, subscription) => {
    if (subscription.snapshotIntervalMinutes <= 0) {
      return minimum;
    }
    return Math.min(minimum, subscription.snapshotIntervalMinutes);
  }, Number.POSITIVE_INFINITY);
  return Number.isFinite(interval) ? interval : 0;
}

interface PerformListingCheckOptions {
  force?: boolean;
  enqueuedAt?: number;
  includeSubscriptionId?: string;
}

export interface ListingCheckRun {
  retailerListingId: string;
  success: boolean;
  previous: ListingCheckState;
  current: ListingCheckState;
  errorCode?: string;
  outcomes: Map<string, CheckOutcome>;
}

/**
 * Perform one retailer check for a shared listing.
 *
 * The retailer is contacted at most once per listing cycle:
 *  - the scheduler groups due subscriptions by listing;
 *  - a database lease serialises concurrent workers;
 *  - a job queued before a newer successful check reuses that result;
 *  - the row lock in updateListingFromCheck prevents duplicate
 *    observations when checks still race at the database boundary.
 *
 * The result is fanned out to every active subscription. Each user's
 * notifications are evaluated independently against their own configuration
 * and dedup state.
 */
export async function performListingCheck(
  retailerListingId: string,
  options: PerformListingCheckOptions = {},
): Promise<ListingCheckRun> {
  const startedAt = Date.now();
  registerBuiltInAdapters();

  const listing = await db.retailerListing.findUnique({
    where: { id: retailerListingId },
  });
  if (!listing) {
    logger.warn(
      { component: "monitoring", retailerListingId },
      "check job for missing retailer listing; skipping",
    );
    return {
      retailerListingId,
      success: false,
      previous: { availability: "UNKNOWN", priceMinor: null },
      current: { availability: "UNKNOWN", priceMinor: null },
      errorCode: "LISTING_NOT_FOUND",
      outcomes: new Map(),
    };
  }

  const subscriptions = await loadSubscriptionsForCheck(
    retailerListingId,
    options.includeSubscriptionId,
  );
  const current = stateFromListing(listing);

  if (subscriptions.length === 0) {
    // An inventory item can have historical alert rules without any
    // monitoring subscription. In that case the alert sweep drives checks,
    // so do not skip merely because no subscription exists.
    const hasAlertRules = await db.priceAlertRule.findFirst({
      where: {
        enabled: true,
        inventoryItem: {
          canonicalProductId: listing.canonicalProductId,
        },
      },
      select: { id: true },
    });
    if (!hasAlertRules) {
      logger.info(
        { component: "monitoring", retailerListingId },
        "no active subscriptions or alert rules for listing; skipping check",
      );
      return {
        retailerListingId,
        success: false,
        previous: current,
        current,
        errorCode: "NO_ACTIVE_SUBSCRIPTIONS",
        outcomes: new Map(),
      };
    }
  }

  if (
    !options.force &&
    options.enqueuedAt !== undefined &&
    listing.lastSuccessfulAt !== null &&
    listing.lastSuccessfulAt.getTime() >= options.enqueuedAt
  ) {
    logger.info(
      { component: "monitoring", retailerListingId },
      "reusing a newer shared check result",
    );
    return {
      retailerListingId,
      success: true,
      previous: current,
      current,
      outcomes: new Map(),
    };
  }

  let leaseHeld = await claimListingCheck(listing.id);
  if (!leaseHeld) {
    logger.info(
      { component: "monitoring", retailerListingId },
      "another worker holds the listing check lease; skipping duplicate check",
    );
    return {
      retailerListingId,
      success: true,
      previous: current,
      current,
      outcomes: new Map(),
    };
  }

  const releaseLease = async (): Promise<void> => {
    if (leaseHeld) {
      leaseHeld = false;
      await releaseListingCheck(listing.id);
    }
  };

  const snapshotFallback = minPositiveSnapshotInterval(subscriptions);

  try {
    // The lease may have been acquired after a newer check committed.
    if (!options.force && options.enqueuedAt !== undefined) {
      const fresh = await db.retailerListing.findUnique({
        where: { id: listing.id },
        select: {
          currentAvailability: true,
          currentPriceMinor: true,
          lastSuccessfulAt: true,
        },
      });
      if (
        fresh?.lastSuccessfulAt &&
        fresh.lastSuccessfulAt.getTime() >= options.enqueuedAt
      ) {
        const freshState = stateFromListing(fresh);
        return {
          retailerListingId,
          success: true,
          previous: freshState,
          current: freshState,
          outcomes: new Map(),
        };
      }
    }

    const adapter = retailerRegistry.getById(listing.retailerId);
    if (!adapter) {
      const error = `No adapter registered for retailer "${listing.retailerId}"`;
      logger.error(
        { component: "monitoring", retailerListingId: listing.id },
        error,
      );
      await releaseLease();
      const outcomes = await fanOutError(
        subscriptions,
        current,
        "ADAPTER_MISSING",
        error,
        startedAt,
      );
      await advanceSubscriptionSchedules(subscriptions);
      return {
        retailerListingId,
        success: false,
        previous: current,
        current,
        errorCode: "ADAPTER_MISSING",
        outcomes,
      };
    }

    try {
      const rawDetails = await adapter.getProduct(listing.url);
      const validated = productDetailsSchema.safeParse(rawDetails);
      if (!validated.success) {
        logger.error(
          {
            component: "monitoring",
            retailerId: adapter.id,
            issues: validated.error.issues,
          },
          "adapter returned invalid product details during check",
        );
        await releaseLease();
        const outcomes = await fanOutError(
          subscriptions,
          current,
          "PARSE",
          "Adapter returned invalid product details",
          startedAt,
        );
        await advanceSubscriptionSchedules(subscriptions);
        return {
          retailerListingId,
          success: false,
          previous: current,
          current,
          errorCode: "PARSE",
          outcomes,
        };
      }

      const details = validated.data;
      const result = await updateListingFromCheck(listing.id, details, {
        snapshotIntervalMinutes: snapshotFallback,
      });
      await releaseLease();

      const outcomes = await fanOutSuccess(
        subscriptions,
        result.previous,
        result.current,
        startedAt,
      );
      await advanceSubscriptionSchedules(subscriptions);
      await evaluateInventoryAlertsSafely(
        listing.id,
        result.observation?.observedAt,
      );

      return {
        retailerListingId,
        success: true,
        previous: result.previous,
        current: result.current,
        outcomes,
      };
    } catch (error) {
      if (isRetailerError(error)) {
        // Marketplaces selling unique items signal a sold product by
        // removing it from their API. Treat that as a normal out-of-stock
        // observation when the adapter declares those semantics.
        if (
          error.code === "PRODUCT_NOT_FOUND" &&
          adapter.treatNotFoundAsOutOfStock
        ) {
          logger.info(
            {
              component: "monitoring",
              retailerListingId: listing.id,
              retailerId: adapter.id,
            },
            "product not found; recording out of stock",
          );
          const result = await updateListingFromCheck(
            listing.id,
            {
              retailerId: listing.retailerId,
              retailerProductId: listing.retailerProductId ?? undefined,
              name: listing.name,
              url: listing.url,
              imageUrl: listing.imageUrl ?? undefined,
              currency: listing.currency,
              priceMinor: undefined,
              availability: "OUT_OF_STOCK",
              lastUpdated: new Date(),
            },
            {
              delisted: true,
              snapshotIntervalMinutes: snapshotFallback,
            },
          );
          await releaseLease();

          const outcomes = await fanOutSuccess(
            subscriptions,
            result.previous,
            result.current,
            startedAt,
          );
          await advanceSubscriptionSchedules(subscriptions);
          await evaluateInventoryAlertsSafely(
            listing.id,
            result.observation?.observedAt,
          );

          return {
            retailerListingId,
            success: true,
            previous: result.previous,
            current: result.current,
            outcomes,
          };
        }

        logger.warn(
          {
            component: "monitoring",
            retailerListingId: listing.id,
            retailerId: adapter.id,
            code: error.code,
            retryable: error.retryable,
          },
          "retailer check failed",
        );
        await releaseLease();
        await markListingChecked(listing.id);
        const outcomes = await fanOutError(
          subscriptions,
          current,
          error.code,
          error.message,
          startedAt,
        );
        await advanceSubscriptionSchedules(subscriptions);
        if (error.retryable) {
          throw error; // BullMQ retries with exponential backoff.
        }
        return {
          retailerListingId,
          success: false,
          previous: current,
          current,
          errorCode: error.code,
          outcomes,
        };
      }

      logger.error(
        {
          component: "monitoring",
          retailerListingId: listing.id,
          err: error,
        },
        "unexpected error during check",
      );
      await releaseLease();
      await markListingChecked(listing.id);
      await fanOutError(
        subscriptions,
        current,
        "UNKNOWN",
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
      await advanceSubscriptionSchedules(subscriptions);
      throw error;
    }
  } finally {
    await releaseLease();
  }
}

/**
 * Worker entry point for a shared-listing check. The scheduler passes the
 * time the job was queued so a delayed duplicate can reuse a newer result.
 */
export async function processListingCheckJob(data: CheckJobData): Promise<{
  retailerListingId: string;
  success: boolean;
  errorCode?: string;
  checkedSubscriptions: number;
}> {
  const run = await performListingCheck(data.retailerListingId, {
    force: data.force ?? false,
    enqueuedAt: data.enqueuedAt,
    includeSubscriptionId: data.requestedBySubscriptionId,
  });
  return {
    retailerListingId: run.retailerListingId,
    success: run.success,
    errorCode: run.errorCode,
    checkedSubscriptions: run.outcomes.size,
  };
}

/**
 * Execute a single check for one subscription. Used by tests and direct
 * callers; scheduled production checks go through the shared-listing path.
 */
export async function processCheckJob(
  data: SingleCheckJobData,
): Promise<CheckOutcome> {
  const subscription = await findSubscription(data.subscriptionId);
  if (!subscription) {
    logger.warn(
      { component: "monitoring", subscriptionId: data.subscriptionId },
      "check job for missing subscription; skipping",
    );
    return {
      subscriptionId: data.subscriptionId,
      retailerListingId: "",
      previous: { availability: "UNKNOWN", priceMinor: null },
      current: { availability: "UNKNOWN", priceMinor: null },
      success: false,
      errorCode: "SUBSCRIPTION_NOT_FOUND",
    };
  }

  const run = await performListingCheck(subscription.retailerListingId, {
    force: true,
    includeSubscriptionId: subscription.id,
  });

  const outcome = run.outcomes.get(subscription.id);
  if (outcome) {
    return outcome;
  }

  return {
    subscriptionId: subscription.id,
    retailerListingId: subscription.retailerListingId,
    previous: run.previous,
    current: run.current,
    success: run.success,
    errorCode: run.errorCode ?? "CHECK_NOT_RUN",
  };
}

/** Re-exported for convenience of API callers. */
export { UnsupportedRetailerError };
