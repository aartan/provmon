import { describe, expect, it } from "vitest";

import { MockRetailerAdapter } from "@/modules/retailers/testing/mock/adapter";
import { createMockStore } from "@/modules/retailers/testing/mock/store";
import {
  hostnameMatches,
  normalizeHostname,
  RetailerRegistry,
} from "@/modules/retailers/core/retailer-registry";

function makeAdapter(overrides: Partial<{
  id: string;
  domains: string[];
}> = {}): MockRetailerAdapter {
  const store = createMockStore();
  const adapter = new MockRetailerAdapter(store);
  return Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
    id: overrides.id ?? adapter.id,
    supportedDomains: overrides.domains ?? adapter.supportedDomains,
  }) as MockRetailerAdapter;
}

describe("hostnameMatches", () => {
  it("matches exact hostnames", () => {
    expect(hostnameMatches("mock-retailer.test", "mock-retailer.test")).toBe(true);
  });

  it("matches subdomains", () => {
    expect(hostnameMatches("www.mock-retailer.test", "mock-retailer.test")).toBe(true);
    expect(hostnameMatches("a.b.mock-retailer.test", "mock-retailer.test")).toBe(true);
  });

  it("does not match lookalike domains", () => {
    expect(hostnameMatches("fakemock-retailer.test", "mock-retailer.test")).toBe(false);
    expect(hostnameMatches("mock-retailer.test.evil.com", "mock-retailer.test")).toBe(false);
    expect(hostnameMatches("other.test", "mock-retailer.test")).toBe(false);
  });

  it("is case-insensitive and tolerant of trailing dots", () => {
    expect(hostnameMatches("MOCK-RETAILER.TEST", "mock-retailer.test")).toBe(true);
    expect(hostnameMatches("mock-retailer.test.", "mock-retailer.test")).toBe(true);
  });
});

describe("normalizeHostname", () => {
  it("lowercases and strips trailing dots", () => {
    expect(normalizeHostname("WWW.Example.COM.")).toBe("www.example.com");
  });
});

describe("RetailerRegistry", () => {
  it("registers and retrieves adapters by id", () => {
    const registry = new RetailerRegistry();
    const adapter = makeAdapter();
    registry.register(adapter);
    expect(registry.getById("mock")).toBe(adapter);
  });

  it("rejects duplicate ids", () => {
    const registry = new RetailerRegistry();
    registry.register(makeAdapter());
    expect(() => registry.register(makeAdapter())).toThrow(/already registered/);
  });

  it("allows idempotent re-registration of the same instance", () => {
    const registry = new RetailerRegistry();
    const adapter = makeAdapter();
    registry.register(adapter);
    expect(() => registry.register(adapter)).not.toThrow();
  });

  it("rejects duplicate domains across adapters", () => {
    const registry = new RetailerRegistry();
    registry.register(makeAdapter({ id: "one", domains: ["shop.example"] }));
    expect(() =>
      registry.register(makeAdapter({ id: "two", domains: ["shop.example"] })),
    ).toThrow(/already claimed/);
  });

  it("rejects invalid ids and empty domain lists", () => {
    const registry = new RetailerRegistry();
    expect(() => registry.register(makeAdapter({ id: "Bad Id!" }))).toThrow(/Invalid retailer adapter id/);
    expect(() =>
      registry.register(makeAdapter({ id: "empty", domains: [] })),
    ).toThrow(/no supported domains/);
  });

  it("finds adapters by exact and subdomain hostnames", () => {
    const registry = new RetailerRegistry();
    registry.register(makeAdapter());
    expect(registry.getByDomain("mock-retailer.test")?.id).toBe("mock");
    expect(registry.getByDomain("www.mock-retailer.test")?.id).toBe("mock");
    expect(registry.getByDomain("unknown.test")).toBeUndefined();
  });

  it("lists all registered adapters", () => {
    const registry = new RetailerRegistry();
    registry.register(makeAdapter());
    expect(registry.list().map((a) => a.id)).toEqual(["mock"]);
  });
});
