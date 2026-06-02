-- Seller sending/return address — authoritative DB field replacing live Stripe lookup.
-- Nullable JSON matching orders.shipping_address shape: { name, line1, line2, city, postal_code, country }
-- Existing rows get NULL; sellers populate via the new PUT /api/users/sending-address endpoint.
ALTER TABLE "users" ADD COLUMN "sending_address" JSONB;
