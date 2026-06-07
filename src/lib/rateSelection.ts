import type { Rate } from 'shippo/models/components';

export interface RateSelectionInput {
  rates: Rate[];
  buyerPaidShippingCost: number;
}

export interface RateSelectionResult {
  selectedRate: Rate;
  overBudget: boolean;
  reason: 'best_within_budget' | 'cheapest_over_budget';
}

const UNTRACKED_KEYWORDS = [
  'untracked', 'economy', 'standard letter', 'postable',
  'large letter', '2nd class letter', 'media mail', 'book post',
  'printed papers', 'royal mail 24', 'royal mail 48',
];

const TRACKED_KEYWORDS = [
  'tracked', 'signed', 'express', 'next day', 'courier', 'priority',
  'parcel', 'guaranteed', 'special delivery', 'recorded', 'parcelforce',
  'dpd', 'evri', 'yodel', 'ups', 'fedex', 'dhl', 'hermes',
];

function isTrackedRate(rate: Rate): boolean {
  const serviceName = (rate.servicelevel?.name || '').toLowerCase();
  const serviceToken = ((rate.servicelevel as any)?.token || '').toLowerCase();
  const provider = (rate.provider || '').toLowerCase();

  const isUntracked = UNTRACKED_KEYWORDS.some(kw =>
    serviceName.includes(kw) || serviceToken.includes(kw)
  );
  if (isUntracked) return false;

  const isTracked = TRACKED_KEYWORDS.some(kw =>
    serviceName.includes(kw) || serviceToken.includes(kw) || provider.includes(kw)
  );

  const hasDeliveryEstimate = rate.estimatedDays !== undefined && rate.estimatedDays !== null;
  const isProbablyTracked = hasDeliveryEstimate && parseFloat(rate.amount) >= 2.50;

  return isTracked || isProbablyTracked;
}

/**
 * Reading C: most expensive tracked rate within buyer's budget,
 * fallback to cheapest tracked rate with overBudget flag.
 */
export function selectRate(input: RateSelectionInput): RateSelectionResult | null {
  const { rates, buyerPaidShippingCost } = input;

  if (rates.length === 0) return null;

  const trackedRates = rates.filter(isTrackedRate);
  const pool = trackedRates.length > 0 ? trackedRates : rates;

  const sorted = [...pool].sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));

  const budget = buyerPaidShippingCost || 0;

  const withinBudget = sorted.filter(r => parseFloat(r.amount) <= budget);

  if (withinBudget.length > 0) {
    const bestWithinBudget = withinBudget[withinBudget.length - 1];
    return {
      selectedRate: bestWithinBudget,
      overBudget: false,
      reason: 'best_within_budget',
    };
  }

  return {
    selectedRate: sorted[0],
    overBudget: true,
    reason: 'cheapest_over_budget',
  };
}
