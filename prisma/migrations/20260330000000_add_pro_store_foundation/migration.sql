-- Pro Store Backend Foundation Migration
-- Brief 1 of 7 — Mulligans Web Platform Build
-- Generated: 2026-03-28

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "is_pro_store" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pro_store_approved_at" TIMESTAMP(3),
ADD COLUMN     "pro_store_name" VARCHAR(100),
ADD COLUMN     "pro_store_website" VARCHAR(255),
ADD COLUMN     "subscription_started_at" TIMESTAMP(3),
ADD COLUMN     "subscription_status" VARCHAR(30);

-- CreateTable
CREATE TABLE "public"."pro_store_applications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" VARCHAR(100) NOT NULL,
    "business_email" VARCHAR(255) NOT NULL,
    "business_phone" VARCHAR(30) NOT NULL,
    "website" VARCHAR(255) NOT NULL,
    "seller_type" VARCHAR(30) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "estimated_listings" VARCHAR(20) NOT NULL,
    "instagram_handle" VARCHAR(100),
    "has_existing_store" BOOLEAN NOT NULL DEFAULT false,
    "existing_store_url" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "review_notes" TEXT,
    "reviewed_by" VARCHAR(100),
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pro_store_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pro_store_applications_user_id_idx" ON "public"."pro_store_applications"("user_id");

-- CreateIndex
CREATE INDEX "pro_store_applications_status_idx" ON "public"."pro_store_applications"("status");

-- CreateIndex
CREATE INDEX "pro_store_applications_created_at_idx" ON "public"."pro_store_applications"("created_at");

-- AddForeignKey
ALTER TABLE "public"."pro_store_applications" ADD CONSTRAINT "pro_store_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
