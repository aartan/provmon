-- Historical sale state for price intelligence.
--
-- New observations record the retailer's original price / RRP and discount
-- percentage when available. Existing observations remain NULL: backfilling
-- a sale state that was never recorded would fabricate history.

ALTER TABLE "listing_observations"
  ADD COLUMN "original_price_minor" INTEGER,
  ADD COLUMN "discount_pct" INTEGER;
