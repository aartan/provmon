-- A shared retailer listing must only be fetched by one worker at a time.
-- The lease expires automatically so a crashed worker cannot block checks.

ALTER TABLE "retailer_listings" ADD COLUMN "check_lease_until" TIMESTAMP(3);
