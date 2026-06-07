import { selectRate } from '../../lib/rateSelection';
import type { Rate } from 'shippo/models/components';

function mockRate(overrides: { amount: string; provider?: string; serviceName?: string }): Rate {
  return {
    amount: overrides.amount,
    amountLocal: overrides.amount,
    currency: 'GBP',
    currencyLocal: 'GBP',
    attributes: [],
    carrierAccount: 'acc_test',
    objectCreated: new Date(),
    objectId: `rate_${overrides.amount}`,
    objectOwner: 'test',
    provider: overrides.provider || 'Royal Mail',
    servicelevel: {
      name: overrides.serviceName || 'Tracked 24',
      token: 'tracked_24',
    },
    shipment: 'shp_test',
    estimatedDays: 2,
  };
}

describe('selectRate — Reading C rule', () => {
  test('picks most expensive rate within budget', () => {
    const rates = [mockRate({ amount: '2.50' }), mockRate({ amount: '3.00' }), mockRate({ amount: '3.50' })];
    const result = selectRate({ rates, buyerPaidShippingCost: 3.50 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(3.50);
    expect(result!.overBudget).toBe(false);
    expect(result!.reason).toBe('best_within_budget');
  });

  test('picks most expensive under budget when some exceed it', () => {
    const rates = [
      mockRate({ amount: '2.50' }),
      mockRate({ amount: '3.60' }),
      mockRate({ amount: '5.60' }),
    ];
    const result = selectRate({ rates, buyerPaidShippingCost: 3.50 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(2.50);
    expect(result!.overBudget).toBe(false);
    expect(result!.reason).toBe('best_within_budget');
  });

  test('picks cheapest with overBudget when all rates exceed budget', () => {
    const rates = [
      mockRate({ amount: '4.00' }),
      mockRate({ amount: '5.00' }),
      mockRate({ amount: '6.00' }),
    ];
    const result = selectRate({ rates, buyerPaidShippingCost: 3.50 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(4.00);
    expect(result!.overBudget).toBe(true);
    expect(result!.reason).toBe('cheapest_over_budget');
  });

  test('buyer paid £0 — picks cheapest with overBudget', () => {
    const rates = [mockRate({ amount: '2.50' }), mockRate({ amount: '5.00' })];
    const result = selectRate({ rates, buyerPaidShippingCost: 0 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(2.50);
    expect(result!.overBudget).toBe(true);
    expect(result!.reason).toBe('cheapest_over_budget');
  });

  test('empty rates array returns null', () => {
    const result = selectRate({ rates: [], buyerPaidShippingCost: 3.50 });
    expect(result).toBeNull();
  });

  test('filters out untracked rates', () => {
    const rates = [
      mockRate({ amount: '1.50', serviceName: 'Royal Mail 2nd Class Letter' }),
      mockRate({ amount: '2.50', serviceName: 'Royal Mail Tracked 24' }),
      mockRate({ amount: '4.00', serviceName: 'Royal Mail Tracked 48' }),
    ];
    const result = selectRate({ rates, buyerPaidShippingCost: 5.00 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(4.00);
    expect(result!.overBudget).toBe(false);
  });

  test('falls back to all rates when no tracked rates available', () => {
    const rates = [
      mockRate({ amount: '1.50', serviceName: 'Standard Letter', provider: 'Royal Mail' }),
      mockRate({ amount: '2.00', serviceName: 'Economy Mail', provider: 'Royal Mail' }),
    ];
    // Override estimatedDays to null so isProbablyTracked doesn't fire
    rates.forEach(r => { (r as any).estimatedDays = undefined; });
    const result = selectRate({ rates, buyerPaidShippingCost: 5.00 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(2.00);
  });

  test('exact boundary — rate exactly equal to budget is selected', () => {
    const rates = [mockRate({ amount: '3.50' }), mockRate({ amount: '5.00' })];
    const result = selectRate({ rates, buyerPaidShippingCost: 3.50 });
    expect(result).not.toBeNull();
    expect(parseFloat(result!.selectedRate.amount)).toBe(3.50);
    expect(result!.overBudget).toBe(false);
  });
});
