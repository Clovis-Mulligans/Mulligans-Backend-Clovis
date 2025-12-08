/*
  Warnings:

  - You are about to drop the column `club_type` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `condition` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `loft` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `shaft_flex` on the `listings` table. All the data in the column will be lost.
  - You are about to drop the column `shaft_material` on the `listings` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."listings_condition_idx";

-- AlterTable
ALTER TABLE "public"."listings" DROP COLUMN "club_type",
DROP COLUMN "condition",
DROP COLUMN "loft",
DROP COLUMN "shaft_flex",
DROP COLUMN "shaft_material",
ADD COLUMN     "ball_condition_type" TEXT,
ADD COLUMN     "condition_grip" INTEGER,
ADD COLUMN     "condition_head" INTEGER,
ADD COLUMN     "condition_overall" INTEGER,
ADD COLUMN     "condition_shaft" INTEGER,
ADD COLUMN     "subcategory" TEXT;

-- CreateIndex
CREATE INDEX "listings_subcategory_idx" ON "public"."listings"("subcategory");

-- CreateIndex
CREATE INDEX "listings_condition_overall_idx" ON "public"."listings"("condition_overall");
