/*
  Warnings:

  - The `clothing_size` column on the `users` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `glove_size` column on the `users` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `shoe_size` column on the `users` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "public"."users" DROP COLUMN "clothing_size",
ADD COLUMN     "clothing_size" TEXT[],
DROP COLUMN "glove_size",
ADD COLUMN     "glove_size" TEXT[],
DROP COLUMN "shoe_size",
ADD COLUMN     "shoe_size" TEXT[];
