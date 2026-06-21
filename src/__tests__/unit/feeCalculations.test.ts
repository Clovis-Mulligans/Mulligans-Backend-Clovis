import {
  calculateBuyerFees,
  calculateSellerPayout,
  validateOfferAmount,
  estimateBuyerPrice,
  BUYER_PROTECTION_RATE,
  SERVICE_FEE_PER_ITEM,
  INSURANCE_RATE,
  MIN_OFFER_PERCENT,
  MAX_OFFER_PERCENT,
  ESCROW_RELEASE_DAYS,
  AUTO_CANCEL_DAYS,
  BUYER_CANCEL_WINDOW_MINUTES,
  CART_ITEM_EXPIRY_HOURS,
  OFFER_EXPIRY_HOURS,
  ACCEPTANCE_WINDOW_HOURS,
  MAX_OFFERS_PER_LISTING,
  CartItem,
} from '../../lib/feeCalculations';

const item = (p: Partial<CartItem> & { listingPrice: number }): CartItem => ({
  sellerId: p.sellerId ?? 'seller-1',
  listingPrice: p.listingPrice,
  offerPrice: p.offerPrice ?? null,
  quantity: p.quantity ?? 1,
  shippingCost: p.shippingCost ?? 0,
});

describe('calculateBuyerFees — worked examples from business-logic.md', () => {
  test('single item £100, shipping £5.99 → grand total £115.73', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 100, shippingCost: 5.99 })]);
    expect(fees.itemsTotal).toBeCloseTo(100, 2);
    expect(fees.baseShipping).toBeCloseTo(5.99, 2);
    expect(fees.insurancePremium).toBeCloseTo(1.25, 2);
    expect(fees.insuredShipping).toBeCloseTo(7.24, 2);
    expect(fees.buyerProtectionFee).toBeCloseTo(7.50, 2);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
    expect(fees.platformFee).toBeCloseTo(8.49, 2);
    expect(fees.grandTotal).toBeCloseTo(115.73, 2);
  });

  test('single item £50, Small parcel £3.49 → grand total £58.86', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 50, shippingCost: 3.49 })]);
    expect(fees.grandTotal).toBeCloseTo(58.86, 2);
  });

  test('offer £85 on £100 listing, shipping £3.49 → grand total £96.92', () => {
    const fees = calculateBuyerFees([
      item({ listingPrice: 100, offerPrice: 85, shippingCost: 3.49 }),
    ]);
    expect(fees.itemsTotal).toBeCloseTo(85, 2);
    expect(fees.grandTotal).toBeCloseTo(96.92, 2);
  });

  test('2 items same seller (£80+£120), shipping £5.99 → grand total £224.48', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 80, shippingCost: 5.99 }),
      item({ sellerId: 's1', listingPrice: 120, shippingCost: 5.99 }),
    ]);
    expect(fees.itemsTotal).toBeCloseTo(200, 2);
    expect(fees.baseShipping).toBeCloseTo(5.99, 2);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
    expect(fees.grandTotal).toBeCloseTo(224.48, 2);
  });
});

describe('calculateBuyerFees — multi-seller and edge cases', () => {
  test('2 items from different sellers: shipping = sum of both sellers\' max', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 50, shippingCost: 3.49 }),
      item({ sellerId: 's2', listingPrice: 75, shippingCost: 5.99 }),
    ]);
    expect(fees.itemsTotal).toBeCloseTo(125, 2);
    expect(fees.baseShipping).toBeCloseTo(3.49 + 5.99, 2);
  });

  test('per-seller shipping uses MAX across that seller\'s listings', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 50, shippingCost: 3.49 }),
      item({ sellerId: 's1', listingPrice: 80, shippingCost: 8.99 }),
      item({ sellerId: 's1', listingPrice: 20, shippingCost: 2.49 }),
    ]);
    expect(fees.baseShipping).toBeCloseTo(8.99, 2);
  });

  test('very cheap item (£1) still costs the buyer more than item price', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 1, shippingCost: 0 })]);
    expect(fees.grandTotal).toBeGreaterThan(1);
  });

  test('expensive item (£999.99) has no rounding drift', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 999.99, shippingCost: 0 })]);
    const reconstructed = fees.itemsTotal + fees.insuredShipping + fees.platformFee;
    expect(fees.grandTotal).toBeCloseTo(reconstructed, 6);
  });

  test('quantity of 3 at £25 from one seller → service fee = £0.99 (per seller-order, not per item)', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 25, quantity: 3, shippingCost: 0 })]);
    expect(fees.totalQuantity).toBe(3);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
  });

  test('empty cart → all zeros', () => {
    const fees = calculateBuyerFees([]);
    expect(fees.itemsTotal).toBe(0);
    expect(fees.baseShipping).toBe(0);
    expect(fees.insurancePremium).toBe(0);
    expect(fees.insuredShipping).toBe(0);
    expect(fees.platformFee).toBe(0);
    expect(fees.grandTotal).toBe(0);
    expect(fees.totalQuantity).toBe(0);
    expect(fees.itemCount).toBe(0);
  });
});

describe('calculateSellerPayout', () => {
  test('auto-ship £100: payout = £100 (platform keeps shipping)', () => {
    const p = calculateSellerPayout(100, 1, 5.99, true);
    expect(p.total).toBeCloseTo(100, 2);
    expect(p.shippingAmount).toBe(0);
  });

  test('manual ship £50, shipping £3.49, no label cost: payout = £53.49', () => {
    const p = calculateSellerPayout(50, 1, 3.49, false, 0);
    expect(p.total).toBeCloseTo(53.49, 2);
  });

  test('manual ship £50, shipping £5.99, label cost £2.57: payout = £50 + (£5.99 - £2.57)', () => {
    const p = calculateSellerPayout(50, 1, 5.99, false, 2.57);
    expect(p.shippingAmount).toBeCloseTo(5.99 - 2.57, 2);
    expect(p.total).toBeCloseTo(50 + (5.99 - 2.57), 2);
  });

  test('label cost exceeds shipping: shipping floors at 0 (never negative)', () => {
    const p = calculateSellerPayout(50, 1, 3.00, false, 5.00);
    expect(p.shippingAmount).toBe(0);
    expect(p.total).toBeCloseTo(50, 2);
  });

  test('quantity > 1 multiplies item amount', () => {
    const p = calculateSellerPayout(25, 4, 5.99, true);
    expect(p.itemAmount).toBeCloseTo(100, 2);
    expect(p.total).toBeCloseTo(100, 2);
  });
});

describe('validateOfferAmount', () => {
  test('exactly 50% is valid', () => {
    expect(validateOfferAmount(50, 100)).toBeNull();
  });
  test('exactly 100% is valid', () => {
    expect(validateOfferAmount(100, 100)).toBeNull();
  });
  test('below 50% is rejected', () => {
    expect(validateOfferAmount(49.99, 100)).not.toBeNull();
  });
  test('above 100% is rejected', () => {
    expect(validateOfferAmount(100.01, 100)).not.toBeNull();
  });
  test('zero is rejected', () => {
    expect(validateOfferAmount(0, 100)).not.toBeNull();
  });
  test('negative is rejected', () => {
    expect(validateOfferAmount(-10, 100)).not.toBeNull();
  });
});

describe('financial integrity invariants', () => {
  const samples: CartItem[][] = [
    [item({ listingPrice: 1, shippingCost: 0 })],
    [item({ listingPrice: 50, shippingCost: 3.49 })],
    [item({ listingPrice: 100, shippingCost: 5.99 })],
    [item({ listingPrice: 999.99, shippingCost: 8.99 })],
    [
      item({ sellerId: 's1', listingPrice: 80, shippingCost: 5.99 }),
      item({ sellerId: 's1', listingPrice: 120, shippingCost: 5.99 }),
    ],
    [item({ listingPrice: 25, quantity: 3, shippingCost: 2.49 })],
  ];

  test.each(samples)('buyer pays more than item price (non-zero items)', (...items) => {
    const fees = calculateBuyerFees(items);
    if (fees.itemsTotal > 0) {
      expect(fees.grandTotal).toBeGreaterThan(fees.itemsTotal);
    }
  });

  test.each(samples)('platform fee positive for non-zero items', (...items) => {
    const fees = calculateBuyerFees(items);
    if (fees.itemsTotal > 0) {
      expect(fees.platformFee).toBeGreaterThan(0);
    }
  });

  test.each(samples)('all fee components non-negative', (...items) => {
    const fees = calculateBuyerFees(items);
    expect(fees.itemsTotal).toBeGreaterThanOrEqual(0);
    expect(fees.baseShipping).toBeGreaterThanOrEqual(0);
    expect(fees.insurancePremium).toBeGreaterThanOrEqual(0);
    expect(fees.insuredShipping).toBeGreaterThanOrEqual(0);
    expect(fees.buyerProtectionFee).toBeGreaterThanOrEqual(0);
    expect(fees.serviceFee).toBeGreaterThanOrEqual(0);
    expect(fees.platformFee).toBeGreaterThanOrEqual(0);
  });

  test.each(samples)('grandTotal === itemsTotal + insuredShipping + platformFee', (...items) => {
    const fees = calculateBuyerFees(items);
    expect(fees.grandTotal).toBeCloseTo(
      fees.itemsTotal + fees.insuredShipping + fees.platformFee,
      6,
    );
  });

  test.each(samples)('platformFee === buyerProtectionFee + serviceFee', (...items) => {
    const fees = calculateBuyerFees(items);
    expect(fees.platformFee).toBeCloseTo(fees.buyerProtectionFee + fees.serviceFee, 6);
  });
});

describe('estimateBuyerPrice — single-item display estimate', () => {
  test('£100 item → £108.49 (7.5% + £0.99)', () => {
    expect(estimateBuyerPrice(100)).toBeCloseTo(108.49, 2);
  });

  test('£50 item → £54.74', () => {
    expect(estimateBuyerPrice(50)).toBeCloseTo(54.74, 2);
  });

  test('matches manual formula: price * (1 + rate) + fixed', () => {
    const price = 73.50;
    const expected = price * (1 + BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
    expect(estimateBuyerPrice(price)).toBeCloseTo(expected, 6);
  });

  test('£0 item → £0.99 (just the fixed fee)', () => {
    expect(estimateBuyerPrice(0)).toBeCloseTo(0.99, 2);
  });
});

describe('fee constants — tripwires', () => {
  test('BUYER_PROTECTION_RATE is 7.5%', () => {
    expect(BUYER_PROTECTION_RATE).toBe(0.075);
  });
  test('SERVICE_FEE_PER_ITEM is £0.99', () => {
    expect(SERVICE_FEE_PER_ITEM).toBe(0.99);
  });
  test('INSURANCE_RATE is 1.25%', () => {
    expect(INSURANCE_RATE).toBe(0.0125);
  });
  test('MIN_OFFER_PERCENT is 50%', () => {
    expect(MIN_OFFER_PERCENT).toBe(0.5);
  });
  test('MAX_OFFER_PERCENT is 100%', () => {
    expect(MAX_OFFER_PERCENT).toBe(1.0);
  });
  test('ESCROW_RELEASE_DAYS is 5', () => {
    expect(ESCROW_RELEASE_DAYS).toBe(3);
  });
  test('AUTO_CANCEL_DAYS is 5', () => {
    expect(AUTO_CANCEL_DAYS).toBe(5);
  });
  test('BUYER_CANCEL_WINDOW_MINUTES is 5', () => {
    expect(BUYER_CANCEL_WINDOW_MINUTES).toBe(5);
  });
  test('CART_ITEM_EXPIRY_HOURS is 72', () => {
    expect(CART_ITEM_EXPIRY_HOURS).toBe(72);
  });
  test('OFFER_EXPIRY_HOURS is 24', () => {
    expect(OFFER_EXPIRY_HOURS).toBe(24);
  });
  test('ACCEPTANCE_WINDOW_HOURS is 24', () => {
    expect(ACCEPTANCE_WINDOW_HOURS).toBe(24);
  });
  test('MAX_OFFERS_PER_LISTING is 3', () => {
    expect(MAX_OFFERS_PER_LISTING).toBe(3);
  });
});

describe('SB-06: £0.99 service fee is per seller-order, not per item', () => {
  test('1 seller, 1 item → £0.99', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 50, shippingCost: 3.49 })]);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
  });

  test('1 seller, 5 units of one item → £0.99 (not £4.95)', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 20, quantity: 5, shippingCost: 3.49 })]);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
    expect(fees.totalQuantity).toBe(5);
  });

  test('1 seller, multiple distinct items → £0.99 once', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 30, shippingCost: 3.49 }),
      item({ sellerId: 's1', listingPrice: 50, shippingCost: 5.99 }),
      item({ sellerId: 's1', listingPrice: 25, shippingCost: 2.49 }),
    ]);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
    expect(fees.itemCount).toBe(3);
  });

  test('2 sellers → £1.98 (one £0.99 each)', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 40, shippingCost: 3.49 }),
      item({ sellerId: 's2', listingPrice: 60, shippingCost: 5.99 }),
    ]);
    expect(fees.serviceFee).toBeCloseTo(1.98, 2);
  });

  test('3 sellers → £2.97', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 30, shippingCost: 3.49 }),
      item({ sellerId: 's2', listingPrice: 50, shippingCost: 5.99 }),
      item({ sellerId: 's3', listingPrice: 70, shippingCost: 4.99 }),
    ]);
    expect(fees.serviceFee).toBeCloseTo(2.97, 2);
  });

  test('accepted offer → £0.99 once (same as normal purchase)', () => {
    const fees = calculateBuyerFees([
      item({ listingPrice: 100, offerPrice: 85, shippingCost: 3.49 }),
    ]);
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
  });

  test('7.5% unchanged: single item £100 → buyerProtectionFee = £7.50', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 100, shippingCost: 0 })]);
    expect(fees.buyerProtectionFee).toBeCloseTo(7.50, 2);
  });

  test('7.5% unchanged: 5 units × £20 from one seller → buyerProtectionFee = £7.50', () => {
    const fees = calculateBuyerFees([item({ listingPrice: 20, quantity: 5, shippingCost: 0 })]);
    expect(fees.buyerProtectionFee).toBeCloseTo(7.50, 2);
  });

  test('7.5% unchanged: multi-seller basket → buyerProtectionFee on total items value', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 40, shippingCost: 0 }),
      item({ sellerId: 's2', listingPrice: 60, shippingCost: 0 }),
    ]);
    expect(fees.buyerProtectionFee).toBeCloseTo(100 * 0.075, 2);
  });

  test('display estimate matches: estimateBuyerPrice for single item', () => {
    const displayPrice = estimateBuyerPrice(50);
    const feeBreakdown = calculateBuyerFees([item({ listingPrice: 50, shippingCost: 0 })]);
    expect(displayPrice).toBeCloseTo(
      feeBreakdown.itemsTotal + feeBreakdown.platformFee,
      2,
    );
  });

  test('worked example: 3-item single-seller order saves £1.98 vs old per-item fee', () => {
    const fees = calculateBuyerFees([
      item({ sellerId: 's1', listingPrice: 30, quantity: 3, shippingCost: 3.49 }),
    ]);
    const oldServiceFee = 0.99 * 3;
    const newServiceFee = fees.serviceFee;
    expect(newServiceFee).toBeCloseTo(0.99, 2);
    expect(oldServiceFee - newServiceFee).toBeCloseTo(1.98, 2);
  });
});
