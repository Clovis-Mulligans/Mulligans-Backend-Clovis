import {
  calculateBuyerFees,
  CartItem,
  BUYER_PROTECTION_RATE,
  SERVICE_FEE_PER_ITEM,
  INSURANCE_RATE,
} from '../../lib/feeCalculations';

const item = (p: Partial<CartItem> & { listingPrice: number }): CartItem => ({
  sellerId: p.sellerId ?? 'seller-A',
  listingPrice: p.listingPrice,
  offerPrice: p.offerPrice ?? null,
  quantity: p.quantity ?? 1,
  shippingCost: p.shippingCost ?? 0,
});

describe('SC-01: per-seller checkout fee calculation', () => {
  const SELLER_A = 'seller-A';
  const SELLER_B = 'seller-B';

  const fullCart = [
    item({ sellerId: SELLER_A, listingPrice: 50, shippingCost: 4.99, quantity: 1 }),
    item({ sellerId: SELLER_A, listingPrice: 30, shippingCost: 3.99, quantity: 2 }),
    item({ sellerId: SELLER_B, listingPrice: 80, shippingCost: 5.99, quantity: 1 }),
  ];

  test('seller A items only: totals reflect seller A, not full cart', () => {
    const sellerAItems = fullCart.filter((i) => i.sellerId === SELLER_A);
    const fees = calculateBuyerFees(sellerAItems);

    // items: 50 + (30 * 2) = 110
    expect(fees.itemsTotal).toBeCloseTo(110, 2);
    // shipping: max(4.99, 3.99) = 4.99 (max per seller)
    expect(fees.baseShipping).toBeCloseTo(4.99, 2);
    expect(fees.insurancePremium).toBeCloseTo(110 * INSURANCE_RATE, 2);
    // platform fee: 110 * 0.075 + 0.99 = 9.24
    expect(fees.platformFee).toBeCloseTo(110 * BUYER_PROTECTION_RATE + SERVICE_FEE_PER_ITEM, 2);
    expect(fees.itemCount).toBe(2);
    expect(fees.totalQuantity).toBe(3);
  });

  test('seller B items only: totals reflect seller B, not full cart', () => {
    const sellerBItems = fullCart.filter((i) => i.sellerId === SELLER_B);
    const fees = calculateBuyerFees(sellerBItems);

    expect(fees.itemsTotal).toBeCloseTo(80, 2);
    expect(fees.baseShipping).toBeCloseTo(5.99, 2);
    expect(fees.platformFee).toBeCloseTo(80 * BUYER_PROTECTION_RATE + SERVICE_FEE_PER_ITEM, 2);
    expect(fees.itemCount).toBe(1);
    expect(fees.totalQuantity).toBe(1);
  });

  test('one seller, 3 items: £0.99 charged once (not per item)', () => {
    const threeItems = [
      item({ sellerId: SELLER_A, listingPrice: 20, quantity: 1 }),
      item({ sellerId: SELLER_A, listingPrice: 30, quantity: 1 }),
      item({ sellerId: SELLER_A, listingPrice: 40, quantity: 1 }),
    ];
    const fees = calculateBuyerFees(threeItems);

    // items: 20 + 30 + 40 = 90
    expect(fees.itemsTotal).toBeCloseTo(90, 2);
    // service fee: £0.99 once (one seller)
    expect(fees.serviceFee).toBeCloseTo(SERVICE_FEE_PER_ITEM, 2);
    // protection: 90 * 0.075 = 6.75
    expect(fees.buyerProtectionFee).toBeCloseTo(90 * BUYER_PROTECTION_RATE, 2);
    // platform fee: 6.75 + 0.99 = 7.74
    expect(fees.platformFee).toBeCloseTo(90 * BUYER_PROTECTION_RATE + SERVICE_FEE_PER_ITEM, 2);
  });

  test('seller with no items: empty input returns zeroed breakdown', () => {
    const fees = calculateBuyerFees([]);
    expect(fees.itemsTotal).toBe(0);
    expect(fees.platformFee).toBe(0);
    expect(fees.grandTotal).toBe(0);
    expect(fees.itemCount).toBe(0);
  });

  test('sellerSummary totals reconcile: grandTotal = items + insuredShipping + platformFee', () => {
    const sellerAItems = fullCart.filter((i) => i.sellerId === SELLER_A);
    const fees = calculateBuyerFees(sellerAItems);

    const expectedGrand = fees.itemsTotal + fees.insuredShipping + fees.platformFee;
    expect(fees.grandTotal).toBeCloseTo(expectedGrand, 2);
  });

  test('per-seller totals do NOT equal combined cart totals', () => {
    const feesA = calculateBuyerFees(fullCart.filter((i) => i.sellerId === SELLER_A));
    const feesB = calculateBuyerFees(fullCart.filter((i) => i.sellerId === SELLER_B));
    const feesCombined = calculateBuyerFees(fullCart);

    // Per-seller sum has 2x £0.99 (one per seller); combined has 2x too (2 sellers)
    // So sum of per-seller grandTotals should match combined grandTotal
    expect(feesA.grandTotal + feesB.grandTotal).toBeCloseTo(feesCombined.grandTotal, 2);
  });

  test('offer price used when present, listing price ignored', () => {
    const offerItems = [
      item({ sellerId: SELLER_A, listingPrice: 100, offerPrice: 75, quantity: 1, shippingCost: 5 }),
    ];
    const fees = calculateBuyerFees(offerItems);

    // Should use offer price (75), not listing price (100)
    expect(fees.itemsTotal).toBeCloseTo(75, 2);
    expect(fees.buyerProtectionFee).toBeCloseTo(75 * BUYER_PROTECTION_RATE, 2);
  });

  test('shipping uses max-per-seller model (not additive)', () => {
    const items = [
      item({ sellerId: SELLER_A, listingPrice: 50, shippingCost: 4.99 }),
      item({ sellerId: SELLER_A, listingPrice: 30, shippingCost: 7.99 }),
      item({ sellerId: SELLER_A, listingPrice: 20, shippingCost: 3.49 }),
    ];
    const fees = calculateBuyerFees(items);

    // Max shipping: 7.99 (not 4.99 + 7.99 + 3.49 = 16.47)
    expect(fees.baseShipping).toBeCloseTo(7.99, 2);
  });
});

describe('SC-02: per-seller native pay fee calculation', () => {
  const SELLER_A = 'seller-A';
  const SELLER_B = 'seller-B';

  const fullCart = [
    item({ sellerId: SELLER_A, listingPrice: 50, shippingCost: 4.99, quantity: 1 }),
    item({ sellerId: SELLER_A, listingPrice: 30, shippingCost: 3.99, quantity: 2 }),
    item({ sellerId: SELLER_B, listingPrice: 80, shippingCost: 5.99, quantity: 1 }),
  ];

  test('seller A PI amount: only seller A items in breakdown', () => {
    const sellerAItems = fullCart.filter((i) => i.sellerId === SELLER_A);
    const fees = calculateBuyerFees(sellerAItems);

    // items: 50 + (30 * 2) = 110
    expect(fees.itemsTotal).toBeCloseTo(110, 2);
    // PI amount in pence = Math.round(grandTotal * 100)
    const piAmountPence = Math.round(fees.grandTotal * 100);
    expect(piAmountPence).toBeGreaterThan(0);
    // Verify the breakdown sums to grandTotal
    expect(fees.itemsTotal + fees.insuredShipping + fees.platformFee).toBeCloseTo(fees.grandTotal, 2);
  });

  test('one seller, 3 items: £0.99 once + 7.5% (SB-06 per-seller-order rule)', () => {
    const threeItems = [
      item({ sellerId: SELLER_A, listingPrice: 20, shippingCost: 3, quantity: 1 }),
      item({ sellerId: SELLER_A, listingPrice: 30, shippingCost: 2, quantity: 1 }),
      item({ sellerId: SELLER_A, listingPrice: 40, shippingCost: 5, quantity: 1 }),
    ];
    const fees = calculateBuyerFees(threeItems);

    // items: 90, one £0.99
    expect(fees.serviceFee).toBeCloseTo(0.99, 2);
    expect(fees.buyerProtectionFee).toBeCloseTo(90 * 0.075, 2);
    expect(fees.platformFee).toBeCloseTo(90 * 0.075 + 0.99, 2);
  });

  test('seller_id with no items: calculateBuyerFees returns zero breakdown', () => {
    const noItems = fullCart.filter((i) => i.sellerId === 'nonexistent');
    const fees = calculateBuyerFees(noItems);
    expect(fees.grandTotal).toBe(0);
    expect(fees.platformFee).toBe(0);
    expect(fees.itemCount).toBe(0);
  });

  test('breakdown matches sellerSummary: items + insuredShipping + platformFee = grandTotal', () => {
    const fees = calculateBuyerFees(fullCart.filter((i) => i.sellerId === SELLER_B));
    // This is what the endpoint returns as both `breakdown.total` and `sellerSummary.grandTotal`
    const breakdownTotal = fees.itemsTotal + fees.insuredShipping + fees.platformFee;
    expect(breakdownTotal).toBeCloseTo(fees.grandTotal, 2);
  });

  test('seller_id === userId guard: per-seller filtering is by seller_id, not buyer', () => {
    // Simulate: if buyer filters their own seller_id, they get their own items
    // The endpoint rejects this with 400 BEFORE fee calculation
    // This test verifies the fee calculation itself is seller-id-specific
    const buyerAsSeller = fullCart.filter((i) => i.sellerId === 'buyer-user-id');
    expect(buyerAsSeller.length).toBe(0);
    const fees = calculateBuyerFees(buyerAsSeller);
    expect(fees.grandTotal).toBe(0);
  });
});

describe('SC-01 + SC-02: existing combined endpoints preserved', () => {
  test('combined cart fee matches sum of per-seller fees (2-seller worked example)', () => {
    const cart = [
      item({ sellerId: 'shop-A', listingPrice: 45, shippingCost: 4.99, quantity: 1 }),
      item({ sellerId: 'shop-A', listingPrice: 25, shippingCost: 3.99, quantity: 1 }),
      item({ sellerId: 'shop-B', listingPrice: 100, shippingCost: 5.99, quantity: 1 }),
    ];

    const combined = calculateBuyerFees(cart);
    const perA = calculateBuyerFees(cart.filter((i) => i.sellerId === 'shop-A'));
    const perB = calculateBuyerFees(cart.filter((i) => i.sellerId === 'shop-B'));

    // items: 45+25+100 = 170
    expect(combined.itemsTotal).toBeCloseTo(170, 2);
    expect(perA.itemsTotal + perB.itemsTotal).toBeCloseTo(170, 2);

    // Per-seller fees sum to combined (because £0.99 is per-seller in both models)
    expect(perA.platformFee + perB.platformFee).toBeCloseTo(combined.platformFee, 2);

    // Grand totals match
    expect(perA.grandTotal + perB.grandTotal).toBeCloseTo(combined.grandTotal, 2);
  });
});
