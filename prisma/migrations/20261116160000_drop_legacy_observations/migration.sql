-- Cleanup: the append-only ListingObservation history is now the only
-- observation store. Verify the legacy tables are fully represented before
-- dropping them; abort rather than silently losing history.

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
        RAISE EXCEPTION 'Refusing to drop legacy observations: % timestamps not backfilled', missing_count;
    END IF;
END $$;

DROP TABLE "price_observations";
DROP TABLE "availability_observations";
