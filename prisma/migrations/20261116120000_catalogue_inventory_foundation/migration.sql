-- Catalogue and inventory foundation.
--
-- This migration is deliberately non-destructive:
--   * existing products are renamed to retailer_listings in place;
--   * one canonical product is created per existing listing, reusing the
--     listing id so the mapping is unambiguous;
--   * inventory items are backfilled from distinct existing subscriptions;
--   * no price or availability observations are invented.

-- CreateEnum
CREATE TYPE "PriceAlertType" AS ENUM ('HISTORICAL_LOW', 'BELOW_90_DAY_AVERAGE', 'TWELVE_MONTH_LOW', 'TREND_REVERSAL', 'RETAILER_LOWEST');

-- AlterEnum
ALTER TYPE "MonitoringStatus" ADD VALUE 'ARCHIVED';

-- Rename the shared retailer listing table and its keys in place.
ALTER TABLE "products" RENAME TO "retailer_listings";
ALTER TABLE "retailer_listings" RENAME CONSTRAINT "products_pkey" TO "retailer_listings_pkey";
ALTER INDEX "products_retailer_id_retailer_product_id_key" RENAME TO "retailer_listings_retailer_id_retailer_product_id_key";

-- Rename the listing references on dependent tables.
ALTER TABLE "monitoring_subscriptions" RENAME COLUMN "product_id" TO "retailer_listing_id";
ALTER TABLE "monitoring_subscriptions" RENAME CONSTRAINT "monitoring_subscriptions_product_id_fkey" TO "monitoring_subscriptions_retailer_listing_id_fkey";
ALTER INDEX "monitoring_subscriptions_user_id_product_id_key" RENAME TO "monitoring_subscriptions_user_id_retailer_listing_id_key";

ALTER TABLE "monitoring_checks" RENAME COLUMN "product_id" TO "retailer_listing_id";

ALTER TABLE "price_observations" RENAME COLUMN "product_id" TO "retailer_listing_id";
ALTER TABLE "price_observations" RENAME CONSTRAINT "price_observations_product_id_fkey" TO "price_observations_retailer_listing_id_fkey";
ALTER INDEX "price_observations_product_id_observed_at_idx" RENAME TO "price_observations_retailer_listing_id_observed_at_idx";

ALTER TABLE "availability_observations" RENAME COLUMN "product_id" TO "retailer_listing_id";
ALTER TABLE "availability_observations" RENAME CONSTRAINT "availability_observations_product_id_fkey" TO "availability_observations_retailer_listing_id_fkey";
ALTER INDEX "availability_observations_product_id_observed_at_idx" RENAME TO "availability_observations_retailer_listing_id_observed_at_idx";

-- Add the catalogue/inventory columns to retailer listings. They remain
-- nullable until the backfill below completes.
ALTER TABLE "retailer_listings"
  ADD COLUMN "canonical_product_id" TEXT,
  ADD COLUMN "sku" TEXT,
  ADD COLUMN "gtin" TEXT,
  ADD COLUMN "mpn" TEXT,
  ADD COLUMN "brand" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "current_original_price_minor" INTEGER,
  ADD COLUMN "current_discount_pct" INTEGER,
  ADD COLUMN "last_seen_at" TIMESTAMP(3),
  ADD COLUMN "delisted_at" TIMESTAMP(3);

-- Canonical products are shared catalogue data. Existing listings get one
-- canonical product each, using the listing id to preserve an exact mapping.
CREATE TABLE "canonical_products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "gtin" TEXT,
    "mpn" TEXT,
    "brand_key" TEXT,
    "mpn_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canonical_products_pkey" PRIMARY KEY ("id")
);

INSERT INTO "canonical_products" ("id", "name", "created_at", "updated_at")
SELECT "id", "name", "created_at", "updated_at"
FROM "retailer_listings";

UPDATE "retailer_listings"
SET
  "canonical_product_id" = "id",
  "sku" = "retailer_product_id",
  -- last_successful_at is the last time the retailer actually confirmed the
  -- listing, so it is the only truthful backfill source for last_seen_at.
  "last_seen_at" = "last_successful_at";

ALTER TABLE "retailer_listings"
  ALTER COLUMN "canonical_product_id" SET NOT NULL;

-- Inventory items are user-owned links to canonical products. Backfill one
-- per distinct (user, canonical product) already implied by subscriptions.
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "canonical_product_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

INSERT INTO "inventory_items" ("id", "user_id", "canonical_product_id", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  s."user_id",
  l."canonical_product_id",
  MIN(s."created_at"),
  MAX(s."updated_at")
FROM "monitoring_subscriptions" s
JOIN "retailer_listings" l ON l."id" = s."retailer_listing_id"
GROUP BY s."user_id", l."canonical_product_id";

-- Snapshot configuration lives on the subscription. Historical alert rules
-- belong to the inventory item so they survive subscription pause/archive.
ALTER TABLE "monitoring_subscriptions"
  ADD COLUMN "snapshot_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE TABLE "price_alert_rules" (
    "id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "type" "PriceAlertType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "threshold_pct" INTEGER,
    "state" JSONB,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_alert_rules_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "canonical_products_name_idx" ON "canonical_products"("name");
CREATE UNIQUE INDEX "canonical_products_gtin_key" ON "canonical_products"("gtin");
CREATE UNIQUE INDEX "canonical_products_brand_key_mpn_key_key" ON "canonical_products"("brand_key", "mpn_key");

CREATE INDEX "retailer_listings_canonical_product_id_currency_idx" ON "retailer_listings"("canonical_product_id", "currency");
CREATE INDEX "retailer_listings_retailer_id_last_checked_at_idx" ON "retailer_listings"("retailer_id", "last_checked_at");

CREATE INDEX "inventory_items_user_id_created_at_idx" ON "inventory_items"("user_id", "created_at");
CREATE UNIQUE INDEX "inventory_items_user_id_canonical_product_id_key" ON "inventory_items"("user_id", "canonical_product_id");

CREATE UNIQUE INDEX "price_alert_rules_inventory_item_id_type_key" ON "price_alert_rules"("inventory_item_id", "type");

CREATE INDEX "monitoring_checks_retailer_listing_id_started_at_idx" ON "monitoring_checks"("retailer_listing_id", "started_at");

-- Foreign keys. History and shared catalogue rows are protected with
-- RESTRICT: they must never disappear through a cascade.
ALTER TABLE "retailer_listings" ADD CONSTRAINT "retailer_listings_canonical_product_id_fkey" FOREIGN KEY ("canonical_product_id") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_canonical_product_id_fkey" FOREIGN KEY ("canonical_product_id") REFERENCES "canonical_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "price_alert_rules" ADD CONSTRAINT "price_alert_rules_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing subscription -> listing and observation -> listing constraints
-- were created with CASCADE. Replace them with RESTRICT so a listing cannot
-- be deleted while history or monitoring references it.
ALTER TABLE "monitoring_subscriptions" DROP CONSTRAINT "monitoring_subscriptions_retailer_listing_id_fkey";
ALTER TABLE "monitoring_subscriptions" ADD CONSTRAINT "monitoring_subscriptions_retailer_listing_id_fkey" FOREIGN KEY ("retailer_listing_id") REFERENCES "retailer_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "price_observations" DROP CONSTRAINT "price_observations_retailer_listing_id_fkey";
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_retailer_listing_id_fkey" FOREIGN KEY ("retailer_listing_id") REFERENCES "retailer_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "availability_observations" DROP CONSTRAINT "availability_observations_retailer_listing_id_fkey";
ALTER TABLE "availability_observations" ADD CONSTRAINT "availability_observations_retailer_listing_id_fkey" FOREIGN KEY ("retailer_listing_id") REFERENCES "retailer_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "monitoring_checks" ADD CONSTRAINT "monitoring_checks_retailer_listing_id_fkey" FOREIGN KEY ("retailer_listing_id") REFERENCES "retailer_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Notification history is user history: keep it when a subscription is
-- eventually removed.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_subscription_id_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "monitoring_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
