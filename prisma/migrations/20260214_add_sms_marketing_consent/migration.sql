-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sms_marketing_consent" BOOLEAN NOT NULL DEFAULT false;
