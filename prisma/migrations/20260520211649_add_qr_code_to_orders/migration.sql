-- AlterTable
ALTER TABLE "orders" ADD COLUMN "qr_code_url" TEXT;
ALTER TABLE "orders" ADD COLUMN "qr_code_expires_at" TIMESTAMP(3);
