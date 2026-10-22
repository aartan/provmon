import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { formatMinor } from "@/lib/money";
import {
  evaluateHistoricalAlertRule,
  mergeAlertRuleState,
  parseAlertRuleState,
} from "@/modules/alerts/rules";
import type {
  AlertListingContext,
  AlertTrigger,
  PriceAlertType,
} from "@/modules/alerts/types";
import { computeListingAnalytics } from "@/modules/analytics/listing-analytics";
import { sendHistoricalAlertNotification } from "@/modules/notifications/notification.service";
import type { AvailabilityStatus } from "@/modules/retailers/core/types";

const MS_PER_DAY = 86_400_000;

const log = logger.child({ component: "alerts" });

export class AlertServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "AlertServiceError";
  }
}

export interface SetInventoryAlertRuleInput {
  userId: string;
  inventoryItemId: string;
  type: PriceAlertType;
  currency: string;
  enabled: boolean;
  thresholdPct?: number | null;
}

/**
 * Create/update one inventory-scoped alert rule. The rule currency must
 * exist on one of the canonical product's listings, so a GBP rule can never
 * be configured against a USD-only product.
 */
export async function setInventoryAlertRule(
  input: SetInventoryAlertRuleInput,
) {
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AlertServiceError("Currency must be an ISO 4217 code");
  }

  const inventoryItem = await db.inventoryItem.findFirst({
    where: { id: input.inventoryItemId, userId: input.userId },
    select: {
      id: true,
      canonicalProductId: true,
      canonicalProduct: {
        select: {
          listings: {
            where: { currency },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!inventoryItem) {
    throw new AlertServiceError("Inventory item not found", 404);
  }
  if (inventoryItem.canonicalProduct.listings.length === 0) {
    throw new AlertServiceError(
      `No retailer listing for this inventory item uses ${currency}`,
    );
  }

  const thresholdPct =
    input.type === "BELOW_90_DAY_AVERAGE"
      ? (input.thresholdPct ?? 10)
      : null;
  if (
    thresholdPct !== null &&
    (!Number.isInteger(thresholdPct) ||
      thresholdPct < 1 ||
      thresholdPct > 99)
  ) {
    throw new AlertServiceError(
      "The below-average threshold must be between 1 and 99 percent",
    );
  }

  const rule = await db.priceAlertRule.upsert({
    where: {
      inventoryItemId_type_currency: {
        inventoryItemId: input.inventoryItemId,
        type: input.type,
        currency,
      },
    },
    create: {
      inventoryItemId: input.inventoryItemId,
      type: input.type,
      currency,
      enabled: input.enabled,
      thresholdPct,
    },
    update: {
      enabled: input.enabled,
      thresholdPct,
    },
  });

  if (input.enabled) {
    // Prompt the alert-only sweep to check these listings soon instead of
    // waiting for the next daily cadence.
    await db.retailerListing.updateMany({
      where: {
        canonicalProductId: inventoryItem.canonicalProductId,
        currency,
      },
      data: { nextAlertCheckAt: new Date() },
    });
  }

  return rule;
}

interface AlertListingRow {
  id: string;
  retailerId: string;
  name: string;
  url: string;
  currency: string;
  currentPriceMinor: number | null;
  currentAvailability: AvailabilityStatus;
}

async function buildListingContext(
  listing: AlertListingRow,
  checkedAt: Date,
): Promise<AlertListingContext> {
  const since365 = new Date(checkedAt.getTime() - 365 * MS_PER_DAY);

  const [allTime, recent] = await Promise.all([
    db.listingObservation.aggregate({
      where: {
        retailerListingId: listing.id,
        currency: listing.currency,
        observedAt: { lt: checkedAt },
        priceMinor: { not: null },
      },
      _min: { priceMinor: true },
    }),
    db.listingObservation.findMany({
      where: {
        retailerListingId: listing.id,
        currency: listing.currency,
        observedAt: { gte: since365, lt: checkedAt },
        priceMinor: { not: null },
      },
      orderBy: { observedAt: "asc" },
      select: {
        priceMinor: true,
        originalPriceMinor: true,
        discountPct: true,
        currency: true,
        availability: true,
        observedAt: true,
      },
    }),
  ]);

  let twelveMonthLowMinor: number | null = null;
  for (const observation of recent) {
    if (
      observation.priceMinor !== null &&
      (twelveMonthLowMinor === null ||
        observation.priceMinor < twelveMonthLowMinor)
    ) {
      twelveMonthLowMinor = observation.priceMinor;
    }
  }

  const analytics = computeListingAnalytics({
    retailerListingId: listing.id,
    observations: recent,
    windows: [90],
    now: new Date(checkedAt.getTime() - 1),
    currentCurrency: listing.currency,
  });
  const ninetyDayAverageMinor =
    analytics.byCurrency.find(
      (entry) => entry.currency === listing.currency,
    )?.windows[0]?.averagePriceMinor ?? null;

  const recentPriceLevels: number[] = [];
  for (const observation of recent) {
    if (
      observation.priceMinor !== null &&
      recentPriceLevels.at(-1) !== observation.priceMinor
    ) {
      recentPriceLevels.push(observation.priceMinor);
    }
  }
  if (
    listing.currentPriceMinor !== null &&
    recentPriceLevels.at(-1) !== listing.currentPriceMinor
  ) {
    recentPriceLevels.push(listing.currentPriceMinor);
  }

  return {
    id: listing.id,
    retailerId: listing.retailerId,
    name: listing.name,
    url: listing.url,
    currency: listing.currency,
    currentPriceMinor: listing.currentPriceMinor,
    currentAvailability: listing.currentAvailability,
    allTimeLowMinor: allTime._min.priceMinor ?? null,
    twelveMonthLowMinor,
    ninetyDayAverageMinor,
    recentPriceLevels,
  };
}

async function buildListingContexts(
  canonicalProductId: string,
  currency: string,
  checkedAt: Date,
): Promise<AlertListingContext[]> {
  const listings = await db.retailerListing.findMany({
    where: { canonicalProductId, currency },
    select: {
      id: true,
      retailerId: true,
      name: true,
      url: true,
      currency: true,
      currentPriceMinor: true,
      currentAvailability: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return Promise.all(
    listings.map((listing) => buildListingContext(listing, checkedAt)),
  );
}

function alertSubject(productName: string, trigger: AlertTrigger): string {
  switch (trigger.type) {
    case "HISTORICAL_LOW":
      return `All-time low: ${productName}`;
    case "TWELVE_MONTH_LOW":
      return `12-month low: ${productName}`;
    case "BELOW_90_DAY_AVERAGE":
      return `Below 90-day average: ${productName}`;
    case "RETAILER_LOWEST":
      return `Cheapest retailer: ${productName}`;
    case "TREND_REVERSAL":
      return `Price trend reversal: ${productName}`;
  }
}

function alertText(trigger: AlertTrigger): string {
  const price = formatMinor(
    trigger.priceMinor,
    trigger.currency,
    "en-GB",
  );
  const listing = `${trigger.listingName} at ${trigger.retailerId}`;
  const comparator =
    trigger.comparatorPriceMinor !== null
      ? formatMinor(
          trigger.comparatorPriceMinor,
          trigger.currency,
          "en-GB",
        )
      : null;

  let summary: string;
  switch (trigger.type) {
    case "HISTORICAL_LOW":
      summary = `${listing} is now ${price}, below its previous all-time low of ${comparator}.`;
      break;
    case "TWELVE_MONTH_LOW":
      summary = `${listing} is now ${price}, below its previous 12-month low of ${comparator}.`;
      break;
    case "BELOW_90_DAY_AVERAGE":
      summary = `${listing} is now ${price}, at least ${trigger.thresholdPct}% below its 90-day average of ${comparator}.`;
      break;
    case "RETAILER_LOWEST":
      summary = `${listing} is now the cheapest in-stock listing at ${price}.`;
      break;
    case "TREND_REVERSAL":
      summary = `${listing} reversed its recent price trend and is now ${price}.`;
      break;
  }

  return `${summary}\n\nView the listing: ${trigger.listingUrl}`;
}

/**
 * Evaluate every enabled inventory rule in the checked listing's currency.
 * The caller invokes this after a successful listing observation. Deliveries
 * and dedup state remain user-specific; state advances only when delivery
 * succeeded or was intentionally skipped by the user's preferences.
 */
export async function evaluateInventoryAlertsForListing(
  retailerListingId: string,
  checkedAt: Date,
): Promise<void> {
  const listing = await db.retailerListing.findUnique({
    where: { id: retailerListingId },
    select: { id: true, canonicalProductId: true, currency: true },
  });
  if (!listing) {
    return;
  }

  const inventoryItems = await db.inventoryItem.findMany({
    where: {
      canonicalProductId: listing.canonicalProductId,
      alertRules: {
        some: { enabled: true, currency: listing.currency },
      },
    },
    select: {
      id: true,
      userId: true,
      alertRules: {
        where: { enabled: true, currency: listing.currency },
        select: {
          id: true,
          type: true,
          thresholdPct: true,
          state: true,
        },
      },
    },
  });
  if (inventoryItems.length === 0) {
    return;
  }

  const [contexts, product] = await Promise.all([
    buildListingContexts(
      listing.canonicalProductId,
      listing.currency,
      checkedAt,
    ),
    db.canonicalProduct.findUnique({
      where: { id: listing.canonicalProductId },
      select: { name: true },
    }),
  ]);
  const productName = product?.name ?? "Your product";

  for (const inventoryItem of inventoryItems) {
    for (const rule of inventoryItem.alertRules) {
      const state = parseAlertRuleState(rule.state);
      const triggers = evaluateHistoricalAlertRule({
        type: rule.type as PriceAlertType,
        thresholdPct: rule.thresholdPct,
        state,
        listings: contexts,
      });
      if (triggers.length === 0) {
        continue;
      }

      let nextState = state;
      let acknowledged = false;

      for (const trigger of triggers) {
        const delivery = await sendHistoricalAlertNotification({
          userId: inventoryItem.userId,
          inventoryItemId: inventoryItem.id,
          subject: alertSubject(productName, trigger),
          text: alertText(trigger),
          priceMinor: trigger.priceMinor,
          availability: trigger.availability,
        });
        if (delivery !== "failed") {
          nextState = mergeAlertRuleState(nextState, trigger.statePatch);
          acknowledged = true;
        }
      }

      if (acknowledged) {
        await db.priceAlertRule.update({
          where: { id: rule.id },
          data: {
            state: nextState as unknown as Prisma.InputJsonValue,
            lastTriggeredAt: new Date(),
          },
        });
        log.info(
          {
            inventoryItemId: inventoryItem.id,
            ruleId: rule.id,
            type: rule.type,
          },
          "historical alert evaluated",
        );
      }
    }
  }
}
