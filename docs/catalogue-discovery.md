# Catalogue Discovery & Price History

ProvMon has two complementary modes:

1. **URL monitoring** — a user pastes a product URL and gets scheduled checks
   and notifications. This works for every registered retailer.
2. **Retailer catalogue** — discovery-capable retailers expose their whole
   product list. ProvMon imports it into a shared catalogue, keeps collecting
   price history for every product, and lets users browse it before optionally
   adding monitoring.

The catalogue is shared between users. Monitoring conditions, alerts, and
notifications are still per user: two users can monitor the same listing
independently.

## Data model

| Model | Purpose |
| --- | --- |
| `CanonicalProduct` | Shared product identity, matched by GTIN or normalised brand + MPN. Falls back to one canonical product per listing when no identifier exists. |
| `RetailerListing` | A product as sold by one retailer. Keyed by retailer product id. Carries price, availability, category, brand, image, URL, delisting state, and catalogue sighting timestamps. |
| `ListingObservation` | Append-only shared price/availability history. Unchanged observations extend a price level's duration; they are not independent price changes. |
| `InventoryItem` | User-owned membership in the catalogue. One row per user + canonical product. |
| `MonitoringSubscription` | User-owned monitoring condition for one retailer listing. |
| `RetailerCatalogue` | Global discovery configuration for one retailer id: enabled flag, refresh interval, next refresh, last successful run. |
| `CatalogueDiscoveryRun` | One resumable discovery/refresh run: cursor, revision, progress counters, status, and error. |

`RetailerListing` is the unit of catalogue browsing and detail pages. The
inventory remains canonical-product based, so multiple retailer listings of
the same product collapse into one inventory item.

## Discovery flow

`src/modules/catalogue/discovery.service.ts` orchestrates runs and
`discovery.importer.ts` performs the batched database work.

1. Start a run (`INITIAL` when the retailer has never completed a run,
   otherwise `REFRESH`) or return the retailer's already-active run.
2. A BullMQ job processes exactly one plugin catalogue page.
3. The plugin returns normalised `ProductDetails` plus an opaque `nextCursor`.
4. The importer:
   - deduplicates products within the page;
   - resolves or creates canonical products in batches;
   - creates new listings and their `INITIAL` observation;
   - updates changed price, availability, or descriptive fields;
   - appends a `CHANGE` observation only when price, original price,
     discount, availability, currency, or delisted state changed;
   - records `lastCatalogueSeenAt` for every product seen, including
     unchanged and monitored products.
5. The cursor, revision, and counters are saved atomically. The next page is
   queued after `CATALOGUE_PAGE_DELAY_MS`.
6. When the plugin returns `nextCursor: null`, a `REFRESH` run marks
   catalogue-sourced listings not seen during the run as delisted.

An active unique index on `(retailer_id)` for `QUEUED`/`RUNNING` runs prevents
duplicate collection jobs. A revision guard ensures two workers cannot advance
the same cursor.

### Resumability and retries

- One BullMQ job per page keeps locks short and isolates slow retailers.
- The cursor is persisted after every successful page, so a crash resumes at
  the next page rather than restarting the scan.
- Each page job retries up to five times with exponential backoff. Only the
  final failed attempt marks the run `FAILED`.
- A 429 applies to the whole retailer, not just the page that received it.
  The worker stores a per-retailer cooldown in Redis, honours `Retry-After`
  when present, and delays the job without consuming an attempt until the
  cooldown expires. Each retailer plugin cools down independently.
- A failed run with a saved cursor can be resumed from the retailer page,
  preserving its cursor and counters instead of rescanning from the start.
- Abandoned runs whose heartbeat is over an hour old are failed by the sweep,
  which allows a later scheduled or manual run to start.
- Re-importing a page after a partial failure is idempotent: unchanged
  products add no observation and no listing.

### Price safety

Retailer payloads occasionally contain missing-price sentinels. All plugin
prices are validated against the shared maximum of £10,000,000 in minor units,
and the importer performs a final safe-integer check before writing.
Out-of-range values are stored as `null`; they never abort an entire
catalogue page.


### Delisting and history

Delisting never deletes rows. It sets `delistedAt`, changes availability to
`OUT_OF_STOCK`, and appends a `CHANGE` observation. Delisted products are
hidden from catalogue browsing, but their listing, observations,
subscriptions, and notifications remain available.

To protect against a transient API outage that returns a valid but empty
catalogue, a refresh that sees no products does not delist anything. For
large catalogues (100+ imported products), a refresh must also have seen at
least half of the currently active catalogue before delisting runs.

Active monitoring subscriptions and listings watched by enabled historical
alert rules are excluded from both bulk price updates and delisting. Their
own checks retain notification semantics and update the listing normally.

## Schedules

Two independent schedules run in the catalogue and monitoring queues:

- **Catalogue refresh** — every enabled retailer is refreshed at its
  configured interval (1–24 hours, default 24). A full refresh is also how the
  every-24-hours catalogue history requirement is met; there are no per-product
  daily jobs.
- **Monitored checks** — subscriptions keep their own cadence. New
  subscriptions default to 15 minutes. The monitoring queue is unchanged and
  independent of catalogue discovery.

Both workers are started by the standalone `src/worker.ts` process and, in
development, by `src/instrumentation.ts` when `WORKER_ENABLED` is not `false`.

## Retailer support

Catalogue discovery is an optional plugin capability:

```ts
catalogue?: CatalogueDiscovery;
```

Plugins without it remain available for URL monitoring and are shown as
"URL monitoring only" in retailer management. The discovery contract,
retailer-specific pagination logic, fixtures and tests live with the plugin
package; core only persists the opaque cursor and imports normalised pages.

See [`plugin-architecture.md`](plugin-architecture.md) and
[`plugin-development.md`](plugin-development.md) for the plugin contract and
development workflow.

## Browsing and actions

- `/catalogue` — retailer selector, search across name/SKU/GTIN/brand,
  category/brand/price/stock filters, price/discount sorting, pagination,
  selection, bulk save-to-inventory, and bulk add-to-monitoring.
- `/catalogue/[id]` — listing detail with identifiers, retailer link, current
  price and stock, range statistics, an interactive chart, save-to-inventory,
  and full monitoring configuration.
- `/retailers` — discovery toggle, refresh interval, initial discovery/manual
  refresh, progress, product counts, last success, and latest run status.

History ranges are `7d`, `30d`, `90d`, `180d`, `1y`, and `all`. The repository
fetches one observation before the range boundary as a carry-in, computes
time-weighted statistics, keeps the last observed price extended to now, and
caps rendered points at 2,000.

Bulk limits are 100 selected listings per request. Bulk monitoring defaults
to `BACK_IN_STOCK` every 15 minutes; the detail page supports
`PRICE_DROP`/`BOTH` with a target price. Existing active subscriptions are
skipped; paused or archived subscriptions are resumed.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/catalogue` | Retailers, filters, result page, and the signed-in user's annotations. |
| `GET /api/catalogue/[id]/history?range=` | Range-based price history and statistics. |
| `POST /api/catalogue/inventory` | Bulk save listings to the user's inventory. |
| `POST /api/catalogue/monitor` | Bulk add/resume monitoring. |
| `GET /api/retailers` | Global discovery configuration and latest runs. |
| `PATCH /api/retailers/[id]` | Toggle discovery or change the refresh interval. |
| `POST /api/retailers/[id]/discovery` | Start an initial discovery or manual refresh. |

All routes require an authenticated session.

## Permissions

The application has no role system. Retailer discovery management can be
restricted with `CATALOGUE_ADMIN_EMAILS`, a comma-separated, case-insensitive
email allowlist. When it is empty, any authenticated user may manage
discovery — appropriate for a self-hosted single-user deployment. Catalogue
browsing and per-user inventory/monitoring actions are available to every
authenticated user.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CATALOGUE_PAGE_DELAY_MS` | `500` | Delay between discovery page jobs. |
| `CATALOGUE_ADMIN_EMAILS` | empty | Optional management allowlist. |
| `PROVMON_PLUGIN_DIR` | `plugins` | Directory containing installed retailer plugin packages. |
| `PROVMON_PLUGINS` | empty | Optional comma-separated plugin package allowlist. |

Retailer-specific environment variables are declared by each plugin's
`provmon.plugin.json`; see the plugin package documentation.

The catalogue migration enables the `pg_trgm` extension for fast product
search. The database user must be allowed to create that extension; on
managed Postgres, enable it once via the provider's console instead if the
migration user lacks permission.

## Tests

Catalogue coverage lives next to the modules:

- `discovery.integration.test.ts` — importer creation, change-only history,
  sighting timestamps, protected listings, delisting, and full initial/refresh
  runs using the mock retailer.
- `browse.integration.test.ts` — filters, sorting, pagination, user
  annotations, retailer summaries, detail scoping, and range statistics.
- `catalogue.service.integration.test.ts` — inventory deduplication, bulk
  monitoring, multi-user isolation, resume/skip behaviour, and validation.
- `retailer-admin.integration.test.ts` — management views, settings
  persistence, and validation.
- `admin.test.ts` — allowlist semantics.
- Plugin packages run their own unit, fixture and contract tests; core does not
  test retailer-specific parsing or pagination.

The integration suite uses the dedicated test database and Redis database 1.
Set `RESEND_API_KEY=''` when running locally so notification tests use
Mailpit/SMTP instead of Resend.

## Adding catalogue discovery to a plugin

Implement `CatalogueDiscovery` and expose it from the plugin instance as
`catalogue`:

```ts
catalogue?: CatalogueDiscovery;
```

`fetchPage(cursor)` must be idempotent for a given cursor and return
normalised `ProductDetails`, the next opaque cursor (or `null`), and optionally
a total estimate and progress. Keep page sizes modest, respect the retailer's
rate limits, and partition any API that caps result counts. The importer,
scheduler, UI, and monitoring engine need no changes.

See [`plugin-development.md`](plugin-development.md) for the full plugin
contract and the example plugin template.
