// Shared business constants — single source of truth
export const ESCROW_RELEASE_DAYS = 5;       // Days after delivery before auto-release
export const DISPUTE_WINDOW_DAYS = 5;       // Must match ESCROW_RELEASE_DAYS
export const SHIPPING_DEADLINE_DAYS = 5;    // Seller must ship within this many days
export const AUTO_CANCEL_DAYS = 5;          // Auto-cancel if not shipped within this many days