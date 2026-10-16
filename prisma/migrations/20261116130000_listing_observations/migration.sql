-- Append-only observation history.
--
-- Existing change-only price/availability observations are copied into the
-- new history without inventing values:
--   * rows are merged per listing/timestamp;
--   * each dimension is carried forward independently;
--   * a dimension that has never been observed stays NULL;
--   * listings with no legacy history get no synthetic observation rows.

CREATE TYPE "ObservationKind" AS ENUM ('INITIAL', 'CHANGE', 'SNAPSHOT', 'BACKFILL');

CREATE TABLE "listing_observations" (
    "id" TEXT NOT NULL,
    "retailer_listing_id" TEXT NOT NULL,
    "price_minor" INTEGER,
    "currency" TEXT,
    "availability" "AvailabilityStatus",
    "kind" "ObservationKind" NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_observations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "listing_observations_retailer_listing_id_observed_at_idx" ON "listing_observations"("retailer_listing_id", "observed_at");
CREATE INDEX "listing_observations_retailer_listing_id_kind_observed_at_idx" ON "listing_observations"("retailer_listing_id", "kind", "observed_at");

ALTER TABLE "listing_observations" ADD CONSTRAINT "listing_observations_retailer_listing_id_fkey" FOREIGN KEY ("retailer_listing_id") REFERENCES "retailer_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

WITH events AS (
    SELECT
        "retailer_listing_id",
        "observed_at",
        "price_minor",
        "currency",
        NULL::"AvailabilityStatus" AS "availability"
    FROM "price_observations"
    UNION ALL
    SELECT
        "retailer_listing_id",
        "observed_at",
        NULL::INTEGER AS "price_minor",
        NULL::TEXT AS "currency",
        "availability"
    FROM "availability_observations"
),
grouped AS (
    SELECT
        "retailer_listing_id",
        "observed_at",
        max("price_minor") AS "price_minor",
        max("currency") AS "currency",
        max("availability"::text)::"AvailabilityStatus" AS "availability",
        bool_or("price_minor" IS NOT NULL) AS "has_price",
        bool_or("availability" IS NOT NULL) AS "has_availability"
    FROM events
    GROUP BY "retailer_listing_id", "observed_at"
),
cumulative AS (
    SELECT
        *,
        count(*) FILTER (WHERE "has_price") OVER (
            PARTITION BY "retailer_listing_id"
            ORDER BY "observed_at"
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "price_group",
        count(*) FILTER (WHERE "has_availability") OVER (
            PARTITION BY "retailer_listing_id"
            ORDER BY "observed_at"
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "availability_group"
    FROM grouped
),
backfilled AS (
    SELECT
        "retailer_listing_id",
        "observed_at",
        max("price_minor") OVER (PARTITION BY "retailer_listing_id", "price_group") AS "price_minor",
        max("currency") OVER (PARTITION BY "retailer_listing_id", "price_group") AS "currency",
        max("availability"::text) OVER (PARTITION BY "retailer_listing_id", "availability_group")::"AvailabilityStatus" AS "availability"
    FROM cumulative
)
INSERT INTO "listing_observations" (
    "id",
    "retailer_listing_id",
    "price_minor",
    "currency",
    "availability",
    "kind",
    "observed_at"
)
SELECT
    gen_random_uuid()::text,
    "retailer_listing_id",
    "price_minor",
    "currency",
    "availability",
    'BACKFILL',
    "observed_at"
FROM backfilled;

-- Verify that every legacy observation timestamp is represented. The
-- migration aborts rather than silently losing history.
DO $$
DECLARE
    missing_count INTEGER;
BEGIN
    SELECT count(*) INTO missing_count
    FROM (
        SELECT "retailer_listing_id", "observed_at" FROM "price_observations"
        UNION
        SELECT "retailer_listing_id", "observed_at" FROM "availability_observations"
    ) legacy
    WHERE NOT EXISTS (
        SELECT 1
        FROM "listing_observations" observation
        WHERE observation."retailer_listing_id" = legacy."retailer_listing_id"
          AND observation."observed_at" = legacy."observed_at"
          AND observation."kind" = 'BACKFILL'
    );

    IF missing_count > 0 THEN
        RAISE EXCEPTION 'Observation backfill incomplete: % legacy timestamps missing', missing_count;
    END IF;
END $$;
