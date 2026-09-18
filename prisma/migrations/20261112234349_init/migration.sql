-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MonitoringCondition" AS ENUM ('BACK_IN_STOCK', 'PRICE_DROP', 'BOTH');

-- CreateEnum
CREATE TYPE "MonitoringStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('SUCCESS', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BACK_IN_STOCK', 'PRICE_DROP', 'PRICE_DROP_SUBSEQUENT', 'TEST');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "retailer_id" TEXT NOT NULL,
    "retailer_product_id" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "image_url" TEXT,
    "currency" TEXT NOT NULL,
    "current_price_minor" INTEGER,
    "current_availability" "AvailabilityStatus" NOT NULL,
    "last_checked_at" TIMESTAMP(3),
    "last_successful_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "target_price_minor" INTEGER,
    "condition" "MonitoringCondition" NOT NULL,
    "interval_minutes" INTEGER NOT NULL DEFAULT 60,
    "status" "MonitoringStatus" NOT NULL DEFAULT 'ACTIVE',
    "next_check_at" TIMESTAMP(3),
    "notification_state" JSONB,
    "last_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_observations" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_observations" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "availability" "AvailabilityStatus" NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_checks" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "availability" "AvailabilityStatus",
    "price_minor" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "monitoring_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" "NotificationStatus" NOT NULL,
    "price_minor" INTEGER,
    "availability" "AvailabilityStatus",
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_back_in_stock" BOOLEAN NOT NULL DEFAULT true,
    "notify_price_drop" BOOLEAN NOT NULL DEFAULT true,
    "subsequent_drop_pct" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_retailer_id_retailer_product_id_key" ON "products"("retailer_id", "retailer_product_id");

-- CreateIndex
CREATE INDEX "monitoring_subscriptions_status_next_check_at_idx" ON "monitoring_subscriptions"("status", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_subscriptions_user_id_product_id_key" ON "monitoring_subscriptions"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "price_observations_product_id_observed_at_idx" ON "price_observations"("product_id", "observed_at");

-- CreateIndex
CREATE INDEX "availability_observations_product_id_observed_at_idx" ON "availability_observations"("product_id", "observed_at");

-- CreateIndex
CREATE INDEX "monitoring_checks_subscription_id_started_at_idx" ON "monitoring_checks"("subscription_id", "started_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_sent_at_idx" ON "notifications"("user_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- AddForeignKey
ALTER TABLE "monitoring_subscriptions" ADD CONSTRAINT "monitoring_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_subscriptions" ADD CONSTRAINT "monitoring_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_observations" ADD CONSTRAINT "availability_observations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_checks" ADD CONSTRAINT "monitoring_checks_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "monitoring_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "monitoring_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
