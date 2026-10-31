# Retailer Integration Guide

Adding a new retailer to ProvMon is a contained change: implement one
interface, add fixtures and contract tests, and register the adapter in a
single barrel file. The monitoring engine, scheduler, notification rules,
and UI are never modified.

Both real retailers shipped so far — Cash Converters and CeX — were added
exactly this way; their modules under
`src/modules/retailers/adapters/` are the reference implementations.

## 1. The contract

Every adapter implements `RetailerAdapter`
(`src/modules/retailers/core/adapter.interface.ts`):

- `id` — stable slug, e.g. `"cex"`.
- `name` — human-readable name shown in the UI.
- `supportedDomains` — hostnames the adapter claims (subdomains match).
- `minCheckIntervalMs` — floor for the monitoring interval; the engine
  refuses to check more often (a courtesy guardrail for the retailer).
- `currency` — primary ISO 4217 code.
- `treatNotFoundAsOutOfStock` — `true` when the retailer sells unique or
  limited items and a missing product means "currently not available"
  (marketplace semantics). The engine then records `OUT_OF_STOCK`
  instead of a permanent failure, preserving the stored name and image.
- `parseProductUrl(url)` — extracts the retailer's product id from a
  user-pasted URL. Throws `InvalidProductUrlError` for anything that is
  not a product URL (homepage, search pages, other domains).
- `getProduct(url)` — one call that fetches the current state and returns
  the normalised `ProductDetails` (`retailerId`, `retailerProductId`,
  `name`, canonical `url`, `imageUrl`, `currency`, integer `priceMinor`,
  `availability`, `lastUpdated`). Throws typed `RetailerError` subclasses
  (`NETWORK`, `TIMEOUT`, `RATE_LIMITED`, `BLOCKED`, `PARSE`,
  `PRODUCT_NOT_FOUND`); the engine's retry policy is driven entirely by
  the error's `retryable` flag.
- `catalogue` (optional) — a `CatalogueDiscovery` implementation that
  enumerates the retailer's full product list page by page. Adapters without
  it keep working for URL monitoring. See
  [`catalogue-discovery.md`](catalogue-discovery.md) for the cursor contract
  and import flow.

Availability must be one of `IN_STOCK`, `OUT_OF_STOCK`, `PREORDER`,
`UNKNOWN`. `UNKNOWN` is the honest answer when stock cannot be
determined — it is never coerced to `OUT_OF_STOCK`, neither by adapters
nor by the engine.

## 2. Implement the adapter

Create `src/modules/retailers/adapters/<id>/` with:

- `schemas.ts` — Zod schemas for the *subset* of the retailer's API
  response the adapter consumes. Everything else is ignored; retailer
  field names never cross the module boundary.
- `parser.ts` — URL extraction and the response-to-`ProductDetails`
  mapping. This is the only place retailer field names exist.
- `adapter.ts` — the `RetailerAdapter` implementation: HTTP handling,
  typed error mapping (`429` → rate limited, `403` → blocked, timeouts,
  parse failures), and not-found detection.
- `fixtures.ts` — fixtures captured from the live API, trimmed to the
  consumed fields. Tests never touch the network.
- `index.ts` — barrel export plus a default-constructed singleton
  (`<id>Retailer`).
- `<id>.test.ts` — unit tests plus the shared contract suite.

Rules of thumb, from the real integrations:

- Use the retailer's own public website API when one exists (Cash
  Converters' search endpoint, CeX's Algolia index). Never scrape HTML,
  never bypass CAPTCHAs or anti-bot measures, and respect the
  `minCheckIntervalMs` floor.
- Credentials that the retailer's own website embeds in every visitor's
  browser (e.g. CeX's Algolia search-only keys) are public, read-only
  credentials — fine to ship as env defaults with a comment saying so.
  Real secrets stay in env, never in code.
- One `getProduct` call per check, even when the retailer needs several
  internal requests — compose them inside the adapter.
- Normalise before returning: integer minor-unit prices, canonical URLs,
  percent-encoded image URLs.

## 3. Register the adapter

Two small wiring edits, nothing else:

1. `src/lib/env.ts` — env vars for the API endpoint and any credentials
   (with defaults), following the existing `CASHCONVERTERS_API_URL` /
   `CEX_*` entries. Mirror them in `.env.example`.
2. `src/modules/retailers/adapters/index.ts` — import the singleton and
   add it to the array in `registerBuiltInAdapters()`.

That is the entire integration surface: the resolver discovers the
adapter by domain from the registry, and the engine only ever speaks the
contract interface.

## 4. Prove it

- Run the shared contract tests:
  `npx vitest run src/modules/retailers/adapters/<id>/`
  Every adapter must pass `runRetailerAdapterContractTests` (metadata,
  URL parsing, normalised output, typed errors).
- Smoke-test against the live retailer with a throwaway script
  (`npx tsx <name>.tmp.mts`, delete afterwards) covering: a real product
  URL, URL variants, an unknown id → `ProductNotFoundError`, and
  resolution through `registerBuiltInAdapters()` +
  `resolveRetailerUrl`.
- Confirm zero engine changes:
  `git status` after the work must show no modifications under
  `src/modules/monitoring/`.
- Full suite, typecheck, lint, and build must stay green:
  `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

## 5. Live verification checklist (for the record)

The same flow is exercised live after every integration: paste the URL
into the add-product workflow, confirm identification and current
price/availability, create a subscription, and let the background sweep
run a check end-to-end.
