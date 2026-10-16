-- Schedule an immediate alert-only check for listings that already have
-- enabled historical alert rules. Rule creation does this going forward;
-- this backfill covers rules that predate the scheduler.

UPDATE "retailer_listings" listing
SET "next_alert_check_at" = NOW()
WHERE EXISTS (
    SELECT 1
    FROM "inventory_items" item
    JOIN "price_alert_rules" rule
      ON rule."inventory_item_id" = item."id"
    WHERE item."canonical_product_id" = listing."canonical_product_id"
      AND rule."enabled" = true
);
