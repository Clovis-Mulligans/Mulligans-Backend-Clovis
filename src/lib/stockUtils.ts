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
 * Plain-quantity path: uses atomic `{ increment }` — inherently race-safe.
 *
 * Size-variant path: uses SELECT ... FOR UPDATE within the caller's
 * transaction to acquire a row lock before reading sizeQuantities,
 * then writes the updated buckets + recalculated total. This prevents
 * concurrent restore/decrement operations from interleaving reads and
 * clobbering each other. Callers MUST pass a transaction client (`tx`)
 * when restoring size-variant listings — passing the base PrismaClient
 * would make the lock meaningless (no enclosing transaction to hold it).
 *
 * For size-variant listings, the per-size buckets (specifications.sizeQuantities)
 * are the source of truth; the top-level `quantity` is always recalculated
 * as the sum of all buckets. This is intentional — it corrects any drift
 * between the two representations.
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

  const newStatus = (listing.status === 'deleted' || listing.status === 'off_sale') ? listing.status : 'active';

  if (hasSizeVariants) {
    // Row lock: prevent concurrent read-modify-write races on JSON sizeQuantities.
    // The lock is held until the enclosing transaction commits or rolls back.
    await (tx as any).$queryRawUnsafe(
      `SELECT id FROM listings WHERE id = $1 FOR UPDATE`,
      listingId,
    );

    // Re-read after acquiring lock — another transaction may have committed
    // changes between our initial findUnique and the lock acquisition.
    const locked = await tx.listings.findUnique({
      where: { id: listingId },
      select: { quantity: true, status: true, specifications: true },
    });

    if (!locked) {
      console.error(
        `[STOCK] RESTORE_FAILED listing=${listingId} reason=listing_deleted_during_lock cause=${cause}`,
      );
      return;
    }

    const lockedSpecs = locked.specifications as any;
    const lockedStatus = locked.status as string;
    const lockedPrevQty = locked.quantity;
    const lockedNewStatus = (lockedStatus === 'deleted' || lockedStatus === 'off_sale') ? lockedStatus : 'active';

    const currentSizeQty: number = lockedSpecs.sizeQuantities[selectedSize!] || 0;
    const updatedSpecs = {
      ...lockedSpecs,
      sizeQuantities: {
        ...lockedSpecs.sizeQuantities,
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
        status: lockedNewStatus,
        updated_at: new Date(),
      },
    });

    console.log(
      `[STOCK] INCREMENT listing=${listingId} size=${selectedSize} prev=${lockedPrevQty} sizeQty=${currentSizeQty}→${currentSizeQty + quantity} total=${newTotalStock} cause=${cause}`,
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
