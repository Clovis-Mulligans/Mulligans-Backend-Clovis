-- AlterTable: Add reminder_sent_at to orders table
-- Used for idempotency in the 24-hour inspection reminder cron job.
-- NULL = reminder not yet sent, non-NULL = reminder already sent.
ALTER TABLE "orders" ADD COLUMN "reminder_sent_at" TIMESTAMP(3);
