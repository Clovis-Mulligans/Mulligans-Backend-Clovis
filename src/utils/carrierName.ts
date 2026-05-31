// src/utils/carrierName.ts
//
// Normalises raw carrier names from Shippo (rate.provider) into our
// canonical display names. Stored verbatim on orders.carrier so that
// both display and TRACKING_URLS lookup work without translation.
//
// Background: Hermes UK rebranded to Evri on 1 March 2022, but Shippo's
// internal carrier directory still uses "Hermes UK" as the display name.
// This utility ensures we store user-facing modern names.

const CARRIER_DISPLAY_MAP: Record<string, string> = {
  // Hermes/Evri (rebrand)
  'hermes uk': 'Evri',
  'hermes': 'Evri',
  'hermes_uk': 'Evri',
  'evri': 'Evri',
  'evri_uk': 'Evri',
  
  // Royal Mail
  'royal mail': 'Royal Mail',
  'royal_mail': 'Royal Mail',
  'royalmail': 'Royal Mail',
  
  // DPD
  'dpd': 'DPD',
  'dpd uk': 'DPD',
  'dpd_uk': 'DPD',
  
  // DHL
  'dhl': 'DHL',
  'dhl express': 'DHL',
  'dhl_express': 'DHL',
  
  // UPS
  'ups': 'UPS',
  
  // FedEx
  'fedex': 'FedEx',
  'fed ex': 'FedEx',
  
  // Yodel
  'yodel': 'Yodel',
  
  // Parcelforce
  'parcelforce': 'Parcelforce',
  'parcel force': 'Parcelforce',
};

/**
 * Normalises a raw carrier name to our canonical display name.
 * Falls back to the original value if no mapping found.
 *
 * @param rawCarrier - Carrier name from Shippo (rate.provider) or other source
 * @returns Display-ready carrier name (e.g. "Evri", "Royal Mail")
 */
export function normalizeCarrierName(rawCarrier: string | null | undefined): string {
  if (!rawCarrier) return '';
  const key = rawCarrier.toLowerCase().trim();
  return CARRIER_DISPLAY_MAP[key] || rawCarrier;
}