// src/utils/addressValidation.ts
//
// Shared shipping address validation for all checkout flows.
//
// Per Q1 decision (11 May 2026) — Hybrid model:
//   REJECT if missing: line1, city, postal_code (truly critical for shipping)
//   ALLOW empty:       line2, state (often legitimately empty for UK addresses)
//   DEFAULT:           country = 'GB' if missing
//
// Per Q1/Q2 decisions — caller decides response strategy:
//   Mobile API (nativePaymentController):
//     Catch AddressValidationError → return 400 with structured error
//     Buyer sees "Shipping address incomplete" — can fix and retry
//
//   Stripe webhooks (cartCheckoutController, stripeController):
//     Catch AddressValidationError → return 200 + log + email info@
//     Prevents Stripe retry storm; manual reconciliation needed
//
// Brief: FIX-SHIPPING-P1-002 / FIX 1 / Q1
// Audit: FINDING A-3

export interface ValidatedShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/**
 * Thrown when a shipping address is missing critical fields.
 * Callers should catch this specifically (vs other errors) and decide
 * the response strategy based on context (API vs webhook).
 */
export class AddressValidationError extends Error {
  public readonly missingFields: string[];

  constructor(missingFields: string[]) {
    super(`Shipping address incomplete. Missing: ${missingFields.join(', ')}`);
    this.name = 'AddressValidationError';
    this.missingFields = missingFields;
    Object.setPrototypeOf(this, AddressValidationError.prototype);
  }
}

/**
 * Validate and sanitise a shipping address using the Hybrid model.
 *
 * @param raw - The raw address payload from a payment provider or client
 * @returns A sanitised ValidatedShippingAddress with all fields trimmed
 * @throws AddressValidationError if line1, city, or postal_code are empty/missing
 */
export function validateShippingAddress(
  raw: Partial<ValidatedShippingAddress> | null | undefined
): ValidatedShippingAddress {
  if (!raw) {
    throw new AddressValidationError(['address']);
  }

  const missing: string[] = [];

  // Critical fields — REJECT if empty
  const line1 = (raw.line1 || '').trim();
  const city = (raw.city || '').trim();
  const postalCode = (raw.postal_code || '').trim();

  if (!line1) missing.push('line1');
  if (!city) missing.push('city');
  if (!postalCode) missing.push('postal_code');

  if (missing.length > 0) {
    throw new AddressValidationError(missing);
  }

  // Optional fields — ALLOW empty (warn for visibility)
  const state = (raw.state || '').trim();
  if (!state) {
    console.warn('[ADDRESS] state field empty — acceptable for UK addresses');
  }

  return {
    name: (raw.name || '').trim(),
    line1,
    line2: (raw.line2 || '').trim(),
    city,
    state,
    postal_code: postalCode,
    country: (raw.country || 'GB').trim(),
  };
}