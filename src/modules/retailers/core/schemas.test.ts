import { describe, expect, it } from "vitest";

import { productDetailsSchema } from "@/modules/retailers/core/schemas";
import type { ProductDetails } from "@/modules/retailers/core/types";

function validDetails(overrides: Partial<ProductDetails> = {}): ProductDetails {
  return {
    retailerId: "mock",
    retailerProductId: "in-stock",
    name: "Product",
    url: "https://mock-retailer.test/products/in-stock",
    imageUrl: "https://mock-retailer.test/img.jpg",
    currency: "GBP",
    priceMinor: 9999,
    availability: "IN_STOCK",
    lastUpdated: new Date(),
    ...overrides,
  };
}

describe("productDetailsSchema (normalisation boundary)", () => {
  it("accepts a fully populated product", () => {
    expect(productDetailsSchema.safeParse(validDetails()).success).toBe(true);
  });

  it("accepts optional fields as absent", () => {
    const minimal = {
      retailerId: "mock",
      name: "Product",
      url: "https://mock-retailer.test/products/in-stock",
      currency: "GBP",
      availability: "IN_STOCK",
      lastUpdated: new Date(),
    };
    expect(productDetailsSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts an empty image URL string", () => {
    expect(productDetailsSchema.safeParse(validDetails({ imageUrl: "" })).success).toBe(true);
  });

  it("rejects invalid availability statuses", () => {
    const result = productDetailsSchema.safeParse(
      validDetails({ availability: "SOLD_OUT" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects negative and fractional prices", () => {
    expect(
      productDetailsSchema.safeParse(validDetails({ priceMinor: -1 })).success,
    ).toBe(false);
    expect(
      productDetailsSchema.safeParse(validDetails({ priceMinor: 99.5 })).success,
    ).toBe(false);
  });

  it("rejects invalid currency codes", () => {
    expect(
      productDetailsSchema.safeParse(validDetails({ currency: "gbp" })).success,
    ).toBe(false);
    expect(
      productDetailsSchema.safeParse(validDetails({ currency: "£" })).success,
    ).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(
      productDetailsSchema.safeParse(validDetails({ url: "not-a-url" })).success,
    ).toBe(false);
  });

  it("rejects missing names", () => {
    expect(productDetailsSchema.safeParse(validDetails({ name: "" })).success).toBe(false);
  });
});
