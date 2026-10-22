import {
  ANALYTICS_WINDOW_DAYS,
  type AnalyticsObservation,
  type CurrencyAnalytics,
  type ListingAnalytics,
  type WindowAnalytics,
} from "@/modules/analytics/types";

const MS_PER_DAY = 86_400_000;

interface PriceLevel {
  priceMinor: number;
  currency: string;
  startedAt: Date;
  /**
   * Set when the listing switches currency, so a level from one currency
   * never extends across an observation in another currency.
   */
  validUntil: Date | null;
}

interface EffectiveLevel {
  priceMinor: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

function sortObservations(
  observations: AnalyticsObservation[],
): AnalyticsObservation[] {
  return [...observations].sort(
    (left, right) => left.observedAt.getTime() - right.observedAt.getTime(),
  );
}

/**
 * Build distinct price levels per currency.
 *
 * Repeated observations at the same price are one level: snapshots extend
 * its duration but do not create price changes. A currency switch closes the
 * previous currency's open level and starts a fresh series.
 */
function buildPriceLevels(
  observations: AnalyticsObservation[],
): Map<string, PriceLevel[]> {
  const byCurrency = new Map<string, PriceLevel[]>();
  let previousCurrency: string | null = null;

  for (const observation of observations) {
    if (observation.priceMinor === null || observation.currency === null) {
      continue;
    }
    const currency = observation.currency;

    if (previousCurrency && previousCurrency !== currency) {
      const previousLevels = byCurrency.get(previousCurrency);
      const previousLevel = previousLevels?.at(-1);
      if (previousLevel && previousLevel.validUntil === null) {
        previousLevel.validUntil = observation.observedAt;
      }
    }

    let levels = byCurrency.get(currency);
    if (!levels) {
      levels = [];
      byCurrency.set(currency, levels);
    }

    const last = levels.at(-1);
    if (
      last &&
      last.validUntil === null &&
      last.priceMinor === observation.priceMinor
    ) {
      // Same level: the observation extends its duration.
    } else {
      levels.push({
        priceMinor: observation.priceMinor,
        currency,
        startedAt: observation.observedAt,
        validUntil: null,
      });
    }

    previousCurrency = currency;
  }

  return byCurrency;
}

/**
 * Percentage of sale-known time spent discounted against the original price.
 * Only intervals anchored by an observation that actually carried an original
 * price contribute; missing sale data is never guessed.
 */
function computeSaleFrequency(
  observations: AnalyticsObservation[],
  currency: string,
  windowStartMs: number,
  windowEndMs: number,
): { saleFrequencyPct: number | null; saleDataDurationMs: number } {
  let saleDataDurationMs = 0;
  let saleDurationMs = 0;

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (
      observation.currency !== currency ||
      observation.priceMinor === null ||
      observation.originalPriceMinor === null
    ) {
      continue;
    }

    const startMs = Math.max(observation.observedAt.getTime(), windowStartMs);
    const nextAt =
      index + 1 < observations.length
        ? observations[index + 1].observedAt.getTime()
        : windowEndMs;
    const endMs = Math.min(nextAt, windowEndMs);
    if (endMs <= startMs) {
      continue;
    }

    const durationMs = endMs - startMs;
    saleDataDurationMs += durationMs;
    if (observation.originalPriceMinor > observation.priceMinor) {
      saleDurationMs += durationMs;
    }
  }

  return {
    saleFrequencyPct:
      saleDataDurationMs > 0
        ? (saleDurationMs / saleDataDurationMs) * 100
        : null,
    saleDataDurationMs,
  };
}

function emptyWindow(
  windowDays: number,
  windowStart: Date,
  windowEnd: Date,
): WindowAnalytics {
  return {
    windowDays,
    windowStart,
    windowEnd,
    hasData: false,
    latestPriceMinor: null,
    minPriceMinor: null,
    maxPriceMinor: null,
    minPriceAt: null,
    maxPriceAt: null,
    averagePriceMinor: null,
    percentile: null,
    aboveCurrentPct: null,
    belowCurrentPct: null,
    atCurrentPct: null,
    volatilityPct: null,
    priceChangeCount: 0,
    avgDaysBetweenChanges: null,
    saleFrequencyPct: null,
    saleDataDurationMs: 0,
    trackedDurationMs: 0,
  };
}

function computeWindowMetrics(input: {
  levels: PriceLevel[];
  observations: AnalyticsObservation[];
  currency: string;
  windowDays: number;
  now: Date;
}): WindowAnalytics {
  const { levels, observations, currency, windowDays, now } = input;
  const windowEnd = now;
  const startMs = now.getTime() - windowDays * MS_PER_DAY;
  const endMs = now.getTime();
  const windowStart = new Date(startMs);

  let carryIn: PriceLevel | null = null;
  const inWindow: PriceLevel[] = [];
  for (const level of levels) {
    if (level.startedAt.getTime() < startMs) {
      carryIn = level;
    } else if (level.startedAt.getTime() <= endMs) {
      inWindow.push(level);
    }
  }

  const selected = carryIn ? [carryIn, ...inWindow] : inWindow;
  if (selected.length === 0) {
    return emptyWindow(windowDays, windowStart, windowEnd);
  }

  const effective: EffectiveLevel[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const level = selected[index];
    const next = selected[index + 1];
    const levelStartMs = Math.max(level.startedAt.getTime(), startMs);
    let levelEndMs = next ? next.startedAt.getTime() : endMs;
    if (level.validUntil) {
      levelEndMs = Math.min(levelEndMs, level.validUntil.getTime());
    }
    levelEndMs = Math.min(levelEndMs, endMs);
    if (levelEndMs <= levelStartMs) {
      continue;
    }
    effective.push({
      priceMinor: level.priceMinor,
      startMs: levelStartMs,
      endMs: levelEndMs,
      durationMs: levelEndMs - levelStartMs,
    });
  }

  if (effective.length === 0) {
    return emptyWindow(windowDays, windowStart, windowEnd);
  }

  const trackedDurationMs = effective.reduce(
    (total, level) => total + level.durationMs,
    0,
  );
  const currentPriceMinor = effective[effective.length - 1].priceMinor;

  let belowMs = 0;
  let equalMs = 0;
  let aboveMs = 0;
  let weightedPriceSum = 0;
  let minPriceMinor = Number.POSITIVE_INFINITY;
  let maxPriceMinor = Number.NEGATIVE_INFINITY;
  let minPriceAt: Date | null = null;
  let maxPriceAt: Date | null = null;

  for (const level of effective) {
    if (level.priceMinor < currentPriceMinor) {
      belowMs += level.durationMs;
    } else if (level.priceMinor > currentPriceMinor) {
      aboveMs += level.durationMs;
    } else {
      equalMs += level.durationMs;
    }

    weightedPriceSum += level.priceMinor * level.durationMs;
    if (level.priceMinor < minPriceMinor) {
      minPriceMinor = level.priceMinor;
      minPriceAt = new Date(level.startMs);
    }
    if (level.priceMinor > maxPriceMinor) {
      maxPriceMinor = level.priceMinor;
      maxPriceAt = new Date(level.startMs);
    }
  }

  const weightedMean = weightedPriceSum / trackedDurationMs;
  let varianceSum = 0;
  for (const level of effective) {
    const difference = level.priceMinor - weightedMean;
    varianceSum += level.durationMs * difference * difference;
  }
  const variance = varianceSum / trackedDurationMs;
  const volatilityPct =
    weightedMean > 0 ? (Math.sqrt(variance) / weightedMean) * 100 : null;

  // A change is a contiguous transition into a new price level that starts
  // inside the window. This uses the selected levels rather than the
  // effective durations so a change exactly at the window boundary is not
  // lost when the carry-in level has zero in-window duration. The first
  // selected level is the starting state, and currency-switch gaps are not
  // price changes.
  const changeTimestamps: number[] = [];
  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1];
    const current = selected[index];
    const currentStartMs = current.startedAt.getTime();
    if (currentStartMs < startMs || currentStartMs > endMs) {
      continue;
    }
    const previousEndMs = previous.validUntil
      ? Math.min(previous.validUntil.getTime(), currentStartMs)
      : currentStartMs;
    if (previousEndMs === currentStartMs) {
      changeTimestamps.push(currentStartMs);
    }
  }

  const avgDaysBetweenChanges =
    changeTimestamps.length >= 2
      ? (changeTimestamps[changeTimestamps.length - 1] - changeTimestamps[0]) /
        (changeTimestamps.length - 1) /
        MS_PER_DAY
      : null;

  const sale = computeSaleFrequency(
    observations,
    currency,
    startMs,
    endMs,
  );

  return {
    windowDays,
    windowStart,
    windowEnd,
    hasData: true,
    latestPriceMinor: currentPriceMinor,
    minPriceMinor:
      minPriceMinor === Number.POSITIVE_INFINITY ? null : minPriceMinor,
    maxPriceMinor:
      maxPriceMinor === Number.NEGATIVE_INFINITY ? null : maxPriceMinor,
    minPriceAt,
    maxPriceAt,
    averagePriceMinor: weightedMean,
    percentile:
      trackedDurationMs > 0
        ? ((belowMs + equalMs * 0.5) / trackedDurationMs) * 100
        : null,
    aboveCurrentPct:
      trackedDurationMs > 0 ? (aboveMs / trackedDurationMs) * 100 : null,
    belowCurrentPct:
      trackedDurationMs > 0 ? (belowMs / trackedDurationMs) * 100 : null,
    atCurrentPct:
      trackedDurationMs > 0 ? (equalMs / trackedDurationMs) * 100 : null,
    volatilityPct,
    priceChangeCount: changeTimestamps.length,
    avgDaysBetweenChanges,
    saleFrequencyPct: sale.saleFrequencyPct,
    saleDataDurationMs: sale.saleDataDurationMs,
    trackedDurationMs,
  };
}

export interface ComputeListingAnalyticsInput {
  retailerListingId: string;
  observations: AnalyticsObservation[];
  windows?: readonly number[];
  now?: Date;
  /** Listing's current currency, used to mark the primary series. */
  currentCurrency?: string | null;
}

/**
 * Compute price intelligence for one retailer listing, separated by currency.
 */
export function computeListingAnalytics(
  input: ComputeListingAnalyticsInput,
): ListingAnalytics {
  const now = input.now ?? new Date();
  const windows = input.windows ?? ANALYTICS_WINDOW_DAYS;
  const observations = sortObservations(input.observations).filter(
    (observation) => observation.observedAt.getTime() <= now.getTime(),
  );

  const levelsByCurrency = buildPriceLevels(observations);
  if (levelsByCurrency.size === 0) {
    return {
      retailerListingId: input.retailerListingId,
      generatedAt: now,
      byCurrency: [],
    };
  }

  let latestCurrency: string | null = null;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation.priceMinor !== null && observation.currency !== null) {
      latestCurrency = observation.currency;
      break;
    }
  }

  const currentCurrency =
    input.currentCurrency && levelsByCurrency.has(input.currentCurrency)
      ? input.currentCurrency
      : latestCurrency;

  const byCurrency: CurrencyAnalytics[] = [];
  for (const [currency, levels] of levelsByCurrency) {
    const currentPriceMinor = levels.at(-1)?.priceMinor ?? null;
    byCurrency.push({
      currency,
      isCurrent: currency === currentCurrency,
      currentPriceMinor,
      windows: windows.map((windowDays) =>
        computeWindowMetrics({
          levels,
          observations,
          currency,
          windowDays,
          now,
        }),
      ),
    });
  }

  byCurrency.sort((left, right) => {
    if (left.isCurrent === right.isCurrent) {
      return left.currency.localeCompare(right.currency);
    }
    return left.isCurrent ? -1 : 1;
  });

  return {
    retailerListingId: input.retailerListingId,
    generatedAt: now,
    byCurrency,
  };
}
