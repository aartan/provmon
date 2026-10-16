-- Inventory-scoped historical alerts.
--
-- Rules are evaluated per currency so a GBP rule can never compare a USD
-- listing. Alert-only inventory items get their own shared listing check
-- schedule via retailer_listings.next_alert_check_at.

ALTER TYPE "NotificationType" ADD VALUE 'HISTORICAL_ALERT';

ALTER TABLE "price_alert_rules" ADD COLUMN "currency" TEXT;

-- Existing rules (if any) inherit the item's first listing currency. This is
-- a conservative mapping; no rule is fabricated for an item without one.
UPDATE "price_alert_rules" r
SET "currency" = COALESCE(
    (
        SELECT l."currency"
        FROM "inventory_items" i
        JOIN "retailer_listings" l
          ON l."canonical_product_id" = i."canonical_product_id"
        WHERE i."id" = r."inventory_item_id"
        ORDER BY l."created_at"
        LIMIT 1
    ),
    'GBP'
);

ALTER TABLE "price_alert_rules" ALTER COLUMN "currency" SET NOT NULL;

DROP INDEX "price_alert_rules_inventory_item_id_type_key";
CREATE UNIQUE INDEX "price_alert_rules_inventory_item_id_type_currency_key" ON "price_alert_rules"("inventory_item_id", "type", "currency");

ALTER TABLE "retailer_listings" ADD COLUMN "next_alert_check_at" TIMESTAMP(3);
CREATE INDEX "retailer_listings_next_alert_check_at_idx" ON "retailer_listings"("next_alert_check_at");

ALTER TABLE "notifications" ADD COLUMN "inventory_item_id" TEXT;
CREATE INDEX "notifications_inventory_item_id_sent_at_idx" ON "notifications"("inventory_item_id", "sent_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
