// src/utils/shippingDeadline.ts
// Weekday-aware shipping deadline calculations.
// F1a: weekdays only (Mon-Fri). F1b will add bank holiday support.

/**
 * Returns a Date 5 weekdays (Mon-Fri) after saleDate, at 23:59:59.999.
 * Saturdays and Sundays do not count.
 * Bank holidays still count as weekdays in F1a (F1b will add bank holiday support).
 */
export function calculateShippingDeadline(
  saleDate: Date,
  // bankHolidays?: Date[],
): Date {
  const deadline = new Date(saleDate);
  let weekdaysAdded = 0;

  while (weekdaysAdded < 5) {
    deadline.setDate(deadline.getDate() + 1);
    const day = deadline.getDay();
    if (day !== 0 && day !== 6) {
      weekdaysAdded++;
    }
  }

  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

/**
 * Returns the number of full weekdays between `from` and `deadline`.
 * Saturdays and Sundays do not count.
 * Returns 0 if deadline has passed.
 */
export function weekdaysUntil(
  deadline: Date,
  from: Date = new Date(),
  // bankHolidays?: Date[],
): number {
  if (deadline <= from) return 0;

  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  const target = new Date(deadline);
  target.setHours(0, 0, 0, 0);

  while (cursor < target) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
  }

  return count;
}

/**
 * Returns e.g. "Friday, 30 May"
 */
export function formatShippingDeadline(deadline: Date): string {
  return deadline.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}
