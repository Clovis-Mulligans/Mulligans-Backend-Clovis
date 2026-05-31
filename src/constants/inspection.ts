// Buyer inspection window — time after delivery to confirm receipt or report an issue.
// After this window, payment auto-releases to the seller.
export const INSPECTION_WINDOW_DAYS = 3;

export const INSPECTION_WINDOW_HOURS = INSPECTION_WINDOW_DAYS * 24;
export const INSPECTION_WINDOW_MS = INSPECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Reminder fires 1 day before the window closes
// (2 days post-delivery for a 3-day window)
export const REMINDER_TRIGGER_DAYS_AFTER_DELIVERY = INSPECTION_WINDOW_DAYS - 1;
export const REMINDER_TRIGGER_MS_AFTER_DELIVERY =
  REMINDER_TRIGGER_DAYS_AFTER_DELIVERY * 24 * 60 * 60 * 1000;

// Human-readable formatters for email + UI copy
export const INSPECTION_WINDOW_HUMAN = `${INSPECTION_WINDOW_DAYS} days`;
export const REMINDER_REMAINING_HUMAN = '24 hours';
