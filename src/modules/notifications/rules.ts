import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import type {
  MonitoringCondition,
  SubscriptionNotificationState,
} from "@/modules/monitoring/types";

/**
 * Notification rules engine (pure). Evaluates a check outcome against a
 * subscription's condition and its per-subscription dedup state, and
 * returns the notifications to send plus the state transitions to apply.
 *
 * Dedup semantics:
 *  - Back-in-stock fires on OUT_OF_STOCK/PREORDER -> IN_STOCK. While the
 *    product stays in stock, nothing repeats; going out of stock re-arms.
 *    UNKNOWN never fires (a flaky retailer must not produce false "it's
 *    back!" emails).
 *  - Price-drop fires once when the price crosses at/below the target
 *    while in stock; it re-arms when the price rises above the target.
 *    Optional subsequent-drop notifications fire for further falls of at
 *    least `subsequentDropPct` percent below the last notified price.
 *  - BOTH fires only on a back-in-stock transition where the price also
 *    meets the target.
 */

export type NotificationEventType =
  | "BACK_IN_STOCK"
  | "PRICE_DROP"
  | "PRICE_DROP_SUBSEQUENT";

export interface NotificationEvent {
  type: NotificationEventType;
  priceMinor: number | null;
  availability: AvailabilityStatus;
}

export interface RulesEvaluation {
  events: NotificationEvent[];
  /**
   * State transitions per rule. The back-in-stock rule also tracks the
   * product's current stock state even when no event fires, so callers
   * must apply both updates when the corresponding event was either not
   * emitted or was delivered successfully.
   */
  backInStockState?: Partial<SubscriptionNotificationState>;
  priceState?: Partial<SubscriptionNotificationState>;
}

export interface RulesInput {
  condition: MonitoringCondition;
  targetPriceMinor: number | null;
  current: { availability: AvailabilityStatus; priceMinor: number | null };
  state: SubscriptionNotificationState;
  /** Optional subsequent price-drop threshold in whole percent (1-99). */
  subsequentDropPct?: number | null;
}

const BACK_IN_STOCK_CONDITIONS: readonly MonitoringCondition[] = [
  "BACK_IN_STOCK",
  "BOTH",
];
const PRICE_CONDITIONS: readonly MonitoringCondition[] = ["PRICE_DROP"];

function priceMeetsTarget(
  current: RulesInput["current"],
  targetPriceMinor: number | null,
): boolean {
  return (
    targetPriceMinor !== null &&
    current.priceMinor !== null &&
    current.availability === "IN_STOCK" &&
    current.priceMinor <= targetPriceMinor
  );
}

export function evaluateNotificationRules(input: RulesInput): RulesEvaluation {
  const { condition, current, state } = input;
  const events: NotificationEvent[] = [];
  const evaluation: RulesEvaluation = { events };

  const isBackInStockCondition = BACK_IN_STOCK_CONDITIONS.includes(condition);
  const isPriceCondition = PRICE_CONDITIONS.includes(condition);

  // ---- Back-in-stock rule -------------------------------------------------
  if (isBackInStockCondition) {
    const wasUnavailable =
      state.lastNotifiedAvailability === "OUT_OF_STOCK" ||
      state.lastNotifiedAvailability === "PREORDER";
    const becameInStock = current.availability === "IN_STOCK";

    if (wasUnavailable && becameInStock) {
      const meetsPrice = priceMeetsTarget(current, input.targetPriceMinor);
      const shouldFire = condition === "BACK_IN_STOCK" || (condition === "BOTH" && meetsPrice);

      if (shouldFire) {
        events.push({
          type: "BACK_IN_STOCK",
          priceMinor: current.priceMinor,
          availability: current.availability,
        });
        evaluation.backInStockState = {
          lastNotifiedAvailability: "IN_STOCK",
          ...(condition === "BOTH"
            ? {
                priceDropArmed: false,
                lastNotifiedPriceMinor: current.priceMinor,
              }
            : {}),
        };
      } else {
        // In stock again but no notification (BOTH without price): record
        // the reality so a future stock transition can fire again.
        evaluation.backInStockState = { lastNotifiedAvailability: "IN_STOCK" };
      }
    } else if (
      current.availability === "OUT_OF_STOCK" ||
      current.availability === "PREORDER"
    ) {
      // Re-arm: the next transition into IN_STOCK may notify again.
      if (state.lastNotifiedAvailability !== current.availability) {
        evaluation.backInStockState = {
          lastNotifiedAvailability: current.availability,
        };
      }
    }
    // UNKNOWN or steady IN_STOCK: no change.
  }

  // ---- Price rule (PRICE_DROP only; BOTH is handled by the stock rule) ----
  if (isPriceCondition && input.targetPriceMinor !== null) {
    if (priceMeetsTarget(current, input.targetPriceMinor)) {
      const price = current.priceMinor as number;

      if (state.priceDropArmed) {
        events.push({
          type: "PRICE_DROP",
          priceMinor: price,
          availability: current.availability,
        });
        evaluation.priceState = {
          priceDropArmed: false,
          lastNotifiedPriceMinor: price,
        };
      } else if (input.subsequentDropPct && state.lastNotifiedPriceMinor !== null) {
        const threshold = Math.floor(
          (state.lastNotifiedPriceMinor * (100 - input.subsequentDropPct)) / 100,
        );
        if (price <= threshold) {
          events.push({
            type: "PRICE_DROP_SUBSEQUENT",
            priceMinor: price,
            availability: current.availability,
          });
          evaluation.priceState = { lastNotifiedPriceMinor: price };
        }
      }
    } else if (
      current.availability === "IN_STOCK" &&
      (current.priceMinor === null || current.priceMinor > input.targetPriceMinor) &&
      !state.priceDropArmed
    ) {
      // Price is back above the target: arm for the next crossing.
      evaluation.priceState = { priceDropArmed: true };
    }
  }

  return evaluation;
}
