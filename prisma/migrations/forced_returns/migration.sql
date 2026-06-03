-- Forced returns: flag returns triggered by ≥70% refund threshold
ALTER TABLE "return_requests" ADD COLUMN "is_forced" BOOLEAN NOT NULL DEFAULT false;
