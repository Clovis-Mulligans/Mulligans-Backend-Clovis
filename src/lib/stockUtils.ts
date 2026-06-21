// src/lib/stockUtils.ts
// Shared stock management utilities for all stock-changing flows.
// All stock mutations MUST go through these helpers to ensure audit logging
// and consistent behaviour across cancel, return, dispute, and admin paths.

import { Prisma, PrismaClient } from '@prisma/client';

export type StockChangeCause =
  | 'cart_checkout'
  | 'single_checkout'
  | 'native_checkout'
  | 'order_cancelled'
  | 'return_refund'
  | 'admin_refund'
  | 'dispute_refund';

/**
 * Restore listing stock after a cancellation, return, or refund.
 *
 * Handles both plain-quantity listings and size-variant listings
 * (where specifications.sizeQuantities holds per-size counts).
 * If a listing was marked 'sold' and stock is restored above zero,
 * it is returned to 'active'. Listings with status 'deleted' are
 * left deleted — stock is restored but status is not overridden.
 *
 * Uses atomic increment for plain-quantity listings.
 * For size-variant listings, reads then writes within the caller's
 * transaction — same approach as the decrement path at checkout.
 *
 * Accepts either a Prisma transaction client or the base PrismaClient.
 * Pass `tx` when called inside `$transaction`; pass `prisma` outside.
 */
export async function restoreListingStock(
  tx: Prisma.TransactionClient | PrismaClient,
  listingId: string,
  quantity: number,
  cause: StockChangeCause,
  selectedSize?: string | null,
): Promise<void> {
  const listing = await tx.listings.findUnique({
    where: { id: listingId },
    select: { quantity: true, status: true, specifications: true },
  });

  if (!listing) {
    console.error(
      `[STOCK] RESTORE_FAILED listing=${listingId} reason=listing_not_found cause=${cause}`,
    );
    return;
  }

  const prevQty = listing.quantity;
  const specs = listing.specifications as any;
  const hasSizeVariants = selectedSize && specs?.sizeQuantities && typeof specs.sizeQuantities === 'object';

  const newStatus = listing.status === 'deleted' ? 'deleted' : 'active';

  if (hasSizeVariants) {
    const currentSizeQty: number = specs.sizeQuantities[selectedSize!] || 0;
    const updatedSpecs = {
      ...specs,
      sizeQuantities: {
        ...specs.sizeQuantities,
        [selectedSize!]: currentSizeQty + quantity,
      },
    };
    const newTotalStock = Object.values(updatedSpecs.sizeQuantities)
      .reduce((sum: number, qty: any) => sum + (qty || 0), 0);

    await tx.listings.update({
      where: { id: listingId },
      data: {
        quantity: newTotalStock,
        specifications: updatedSpecs,
        status: newStatus,
        updated_at: new Date(),
      },
    });

    console.log(
      `[STOCK] INCREMENT listing=${listingId} size=${selectedSize} prev=${prevQty} sizeQty=${currentSizeQty}→${currentSizeQty + quantity} total=${newTotalStock} cause=${cause}`,
    );
  } else {
    await tx.listings.update({
      where: { id: listingId },
      data: {
        quantity: { increment: quantity },
        status: newStatus,
        updated_at: new Date(),
      },
    });

    const newQty = prevQty + quantity;
    console.log(
      `[STOCK] INCREMENT listing=${listingId} prev=${prevQty} delta=+${quantity} new=${newQty} cause=${cause}`,
    );
  }
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
