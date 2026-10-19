import type {
  DefaultMockStore,
  MockErrorState,
  MockProductState,
  MockStore,
} from "@/modules/retailers/adapters/mock/types";

function defaultState(sku: string): MockProductState {
  return {
    name: `Mock product ${sku}`,
    imageUrl: "",
    currency: "GBP",
    priceMinor: 9999,
    availability: "IN_STOCK",
  };
}

/**
 * In-memory fixture store for the mock retailer. Deterministic by default;
 * tests create their own stores with `createMockStore` and mutate them.
 */
export function createMockStore(
  initial: Record<string, MockProductState> = {},
): MockStore {
  const states = new Map<string, MockProductState>();
  const errors = new Map<string, MockErrorState>();

  for (const [sku, state] of Object.entries(initial)) {
    states.set(sku, { ...state });
  }

  return {
    get(sku) {
      return states.get(sku);
    },
    set(sku, state) {
      states.set(sku, { ...state });
    },
    setAvailability(sku, availability) {
      const state = states.get(sku);
      if (state) {
        state.availability = availability;
      }
    },
    setPrice(sku, priceMinor) {
      const state = states.get(sku);
      if (state) {
        state.priceMinor = priceMinor;
      }
    },
    setError(sku, error) {
      if (error) {
        errors.set(sku, error);
      } else {
        errors.delete(sku);
      }
    },
    getError(sku) {
      return errors.get(sku);
    },
    delete(sku) {
      states.delete(sku);
      errors.delete(sku);
    },
    clear() {
      states.clear();
      errors.clear();
    },
    list() {
      return [...states.entries()].map(([sku, state]) => ({
        sku,
        state: { ...state },
      }));
    },
  };
}

/**
 * Default store for the built-in mock adapter instance. Products are
 * created lazily on first access with a stable state, so the dev UI can
 * add any SKU without prior setup.
 */
export function createDefaultMockStore(): DefaultMockStore {
  const seededStates: Record<string, MockProductState> = {
    "in-stock": {
      name: "Mock Laptop 15\" — In Stock",
      imageUrl: "",
      currency: "GBP",
      priceMinor: 29999,
      availability: "IN_STOCK",
    },
    "out-of-stock": {
      name: "Mock Camera — Out of Stock",
      imageUrl: "",
      currency: "GBP",
      priceMinor: undefined,
      availability: "OUT_OF_STOCK",
    },
    "price-drops": {
      name: "Mock Headphones — Price Drops",
      imageUrl: "",
      currency: "GBP",
      priceMinor: 14999,
      availability: "IN_STOCK",
    },
    preorder: {
      name: "Mock Console — Preorder",
      imageUrl: "",
      currency: "GBP",
      priceMinor: 44999,
      availability: "PREORDER",
    },
    flaky: {
      name: "Mock Speaker — Flaky",
      imageUrl: "",
      currency: "GBP",
      priceMinor: 5999,
      availability: "IN_STOCK",
    },
  };

  const store = createMockStore(seededStates);

  // Products without a stored state exist and are in stock by default.
  const baseGet = store.get.bind(store);
  const baseSetAvailability = store.setAvailability.bind(store);
  const baseSetPrice = store.setPrice.bind(store);
  const baseDelete = store.delete.bind(store);
  const baseClear = store.clear.bind(store);

  return {
    ...store,
    get(sku) {
      const state = baseGet(sku);
      if (state) {
        return state;
      }
      const created = defaultState(sku);
      store.set(sku, created);
      return created;
    },
    setAvailability(sku, availability) {
      if (!baseGet(sku)) {
        store.set(sku, defaultState(sku));
      }
      baseSetAvailability(sku, availability);
    },
    setPrice(sku, priceMinor) {
      if (!baseGet(sku)) {
        store.set(sku, defaultState(sku));
      }
      baseSetPrice(sku, priceMinor);
    },
    delete(sku) {
      baseDelete(sku);
    },
    clear() {
      baseClear();
    },
    reset() {
      baseClear();
      for (const [sku, state] of Object.entries(seededStates)) {
        store.set(sku, { ...state });
      }
    },
  };
}
