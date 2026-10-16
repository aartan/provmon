-- Retailer-wide catalogue discovery.
--
-- Additive only: existing listings, observations, subscriptions, and history
-- are untouched. Existing subscriptions keep their configured interval; the
-- new default applies only to rows created after this migration.

-- CreateEnum
CREATE TYPE "CatalogueDiscoveryMode" AS ENUM ('INITIAL', 'REFRESH');

-- CreateEnum
CREATE TYPE "CatalogueDiscoveryTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "CatalogueDiscoveryStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "retailer_listings"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "catalogue_discovered_at" TIMESTAMP(3),
  ADD COLUMN "last_catalogue_seen_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "monitoring_subscriptions"
  ALTER COLUMN "interval_minutes" SET DEFAULT 15;

-- CreateTable
CREATE TABLE "retailer_catalogues" (
    "retailer_id" TEXT NOT NULL,
    "discovery_enabled" BOOLEAN NOT NULL DEFAULT false,
    "refresh_interval_hours" INTEGER NOT NULL DEFAULT 24,
    "next_refresh_at" TIMESTAMP(3),
    "last_successful_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retailer_catalogues_pkey" PRIMARY KEY ("retailer_id")
);

-- CreateTable
CREATE TABLE "catalogue_discovery_runs" (
    "id" TEXT NOT NULL,
    "retailer_id" TEXT NOT NULL,
    "mode" "CatalogueDiscoveryMode" NOT NULL,
    "trigger" "CatalogueDiscoveryTrigger" NOT NULL,
    "status" "CatalogueDiscoveryStatus" NOT NULL DEFAULT 'QUEUED',
    "cursor" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "total_estimate" INTEGER,
    "pages_processed" INTEGER NOT NULL DEFAULT 0,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "items_unchanged" INTEGER NOT NULL DEFAULT 0,
    "items_delisted" INTEGER NOT NULL DEFAULT 0,
    "price_changes" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogue_discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_category_idx" ON "retailer_listings"("retailer_id", "category");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_brand_idx" ON "retailer_listings"("retailer_id", "brand");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_current_price_minor_idx" ON "retailer_listings"("retailer_id", "current_price_minor");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_current_availability_idx" ON "retailer_listings"("retailer_id", "current_availability");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_current_discount_pct_idx" ON "retailer_listings"("retailer_id", "current_discount_pct");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_catalogue_discovered_at_idx" ON "retailer_listings"("retailer_id", "catalogue_discovered_at");

-- CreateIndex
CREATE INDEX "retailer_listings_retailer_id_last_catalogue_seen_at_idx" ON "retailer_listings"("retailer_id", "last_catalogue_seen_at");

-- CreateIndex
CREATE INDEX "catalogue_discovery_runs_retailer_id_status_created_at_idx" ON "catalogue_discovery_runs"("retailer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "catalogue_discovery_runs_status_heartbeat_at_idx" ON "catalogue_discovery_runs"("status", "heartbeat_at");

-- At most one queued/running discovery per retailer.
CREATE UNIQUE INDEX "catalogue_discovery_runs_one_active_key"
  ON "catalogue_discovery_runs"("retailer_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');

-- AddForeignKey
ALTER TABLE "catalogue_discovery_runs" ADD CONSTRAINT "catalogue_discovery_runs_retailer_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailer_catalogues"("retailer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigram search indexes for catalogue name/SKU/brand search. These are
-- created in raw SQL because Prisma does not model operator classes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "retailer_listings_name_trgm_idx"
  ON "retailer_listings" USING GIN ("name" gin_trgm_ops);

CREATE INDEX "retailer_listings_sku_trgm_idx"
  ON "retailer_listings" USING GIN ("sku" gin_trgm_ops);

CREATE INDEX "retailer_listings_brand_trgm_idx"
  ON "retailer_listings" USING GIN ("brand" gin_trgm_ops);
