// src/lib/stockUtils.ts
// Shared stock management utilities for all stock-changing flows.
// All stock mutations MUST go through these helpers to ensure audit logging
// and consistent behaviour across cancel, return, dispute, and admin paths.

import { Prisma, PrismaClient } from '@prisma/client';

type StockChangeCause =
  | 'cart_checkout'
  | 'single_checkout'
  | 'native_checkout'
  | 'order_cancelled'
  | 'return_refund'
  | 'admin_refund'
  | 'dispute_refund';

/**
 * Restore listing stock after a cancellation, return, or refund.
 * Uses atomic increment to handle concurrent operations safely.
 * Logs a structured [STOCK] audit line for every mutation.
 *
 * Accepts either a Prisma transaction client (Prisma.TransactionClient)
 * or the base PrismaClient. Pass `tx` when called inside `$transaction`;
 * pass `prisma` when called outside.
 */
export async function restoreListingStock(
  tx: Prisma.TransactionClient | PrismaClient,
  listingId: string,
  quantity: number,
  cause: StockChangeCause,
): Promise<void> {
  const listing = await tx.listings.findUnique({
    where: { id: listingId },
    select: { quantity: true, status: true },
  });

  if (!listing) {
    console.error(
      `[STOCK] RESTORE_FAILED listing=${listingId} reason=listing_not_found cause=${cause}`,
    );
    return;
  }

  const prevQty = listing.quantity;

  await tx.listings.update({
    where: { id: listingId },
    data: {
      quantity: { increment: quantity },
      status: 'active',
      updated_at: new Date(),
    },
  });

  const newQty = prevQty + quantity;
  console.log(
    `[STOCK] INCREMENT listing=${listingId} prev=${prevQty} delta=+${quantity} new=${newQty} cause=${cause}`,
  );
}

/**
 * Log a stock decrement that has already been applied via atomic updateMany.
 * Call this AFTER the decrement succeeds so the audit trail is complete.
 */
export function logStockDecrement(
  listingId: string,
  prevQty: number,
  quantity: number,
  cause: StockChangeCause,
): void {
  const newQty = prevQty - quantity;
  console.log(
    `[STOCK] DECREMENT listing=${listingId} prev=${prevQty} delta=-${quantity} new=${newQty} cause=${cause}`,
  );
}