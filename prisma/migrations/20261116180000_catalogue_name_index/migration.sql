-- Stable, index-backed ordering for catalogue browse pages. The default
-- browse order is name ascending; without this index a 500k-product retailer
-- requires a full sort for every page request.

CREATE INDEX "retailer_listings_retailer_id_name_idx"
  ON "retailer_listings"("retailer_id", "name");
