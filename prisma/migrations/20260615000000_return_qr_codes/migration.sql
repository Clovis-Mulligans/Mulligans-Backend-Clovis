-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN "qr_code_url" TEXT;
ALTER TABLE "return_requests" ADD COLUMN "qr_code_expires_at" TIMESTAMP(3);
