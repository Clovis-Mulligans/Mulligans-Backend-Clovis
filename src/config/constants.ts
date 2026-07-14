import { INSPECTION_WINDOW_DAYS } from '../constants/inspection';

// Buyer inspection window (3 days) — payment auto-releases after this
export const ESCROW_RELEASE_DAYS = INSPECTION_WINDOW_DAYS;

// Dispute window matches inspection window (buyer can dispute during this period)
export const DISPUTE_WINDOW_DAYS = INSPECTION_WINDOW_DAYS;

// Seller shipping deadline (separate from inspection window)
export const SHIPPING_DEADLINE_DAYS = 5;

// Auto-cancel deadline for unshipped orders
export const AUTO_CANCEL_DAYS = 5;

// Return shipping deadline
export const RETURN_SHIPPING_DEADLINE_DAYS = 5;

// Seller inspection window after return delivery — aliased to the single source of truth
export const RETURN_ESCROW_DAYS = INSPECTION_WINDOW_DAYS;