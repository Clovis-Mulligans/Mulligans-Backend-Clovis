-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "email_notifications" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "marketing_emails" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "order_notifications" BOOLEAN NOT NULL DEFAULT true;
