// SC-04: Cart partial-clear on per-seller fulfilment.
//
// Proves the cart-clear in fulfillCartOrder and fulfillCart is listing-scoped
// (not greedy user_id-only). Per-seller fulfilment clears only its own items;
// other sellers' items remain.
//
// Approach: invoke the real fulfilment functions with mocked prisma, then
// inspect the deleteMany where clause inside the $transaction callback.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ─── Stripe mock ───
const mockStripeInstance: any = {
  paymentIntents: { retrieve: jest.fn(), create: jest.fn() },
  refunds: { create: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn(), create: jest.fn() } },
  accounts: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

// ─── Prisma mock ───
// The $transaction mock executes the callback with a mock tx object so we can
// inspect what prisma calls happen inside the transaction.
const mockTx: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  orders: { create: jest.fn() },
  cart_items: { deleteMany: jest.fn() },
  offers: { update: jest.fn() },
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
};

const mockPrisma: any = {
  listings: { findMany: jest.fn(), findUnique: jest.fn() },
  orders: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  users: { findUnique: jest.fn() },
  notifications: { create: jest.fn() },
  cart_items: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock('../../lib/prisma', () => ({ prisma: mockPrisma }));

// ─── Side-effect modules ───
jest.mock('../../utils/addressValidation', () => ({
  validateShippingAddress: jest.fn(),
  AddressValidationError: class extends Error { missingFields: string[] = []; },
}));
jest.mock('../../services/emailService', () => ({
  sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
  sendSaleNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../jobs/offerJobs', () => ({
  expireOffersForSoldItem: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../services/autoShippingService', () => ({
  autoPurchaseLabel: jest.fn().mockResolvedValue({ success: false }),
}));
jest.mock('../../lib/stockUtils', () => ({
  logStockDecrement: jest.fn(),
}));
jest.mock('../../services/metaCapi', () => ({
  sendMetaPurchaseEvent: jest.fn(),
}));
jest.mock('../../utils/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ───
import { CartCheckoutController } from '../../controllers/cartCheckoutController';

// ─── Helpers ───
function fakeListing(id: string, sellerId: string, price = '50', shipping = '5') {
  return {
    id,
    seller_id: sellerId,
    price: { toString: () => price },
    shipping_cost: { toString: () => shipping },
    quantity: 10,
    images: [{ image_url: 'https://img.test/1.jpg' }],
    users: { id: sellerId, stripe_connect_id: `acct_${sellerId}` },
  };
}

function fakeSession(opts: {
  listingIds: string[];
  sellerIds: string[];
  buyerId?: string;
  type?: string;
}) {
  const { listingIds, sellerIds, buyerId = 'buyer_1', type = 'seller_checkout' } = opts;
  const quantities: Record<string, number> = {};
  listingIds.forEach(id => { quantities[id] = 1; });

  return {
    id: 'cs_test_sc04',
    payment_intent: 'pi_test_sc04',
    metadata: {
      type,
      buyer_id: buyerId,
      listing_ids: listingIds.join(','),
      listing_quantities: JSON.stringify(quantities),
      seller_ids: sellerIds.join(','),
      insurance_premium: '1.25',
      insured_value: '100',
      platform_fee: '8.49',
      grand_total: '109.74',
      shipping_total: '5',
      total_quantity: String(listingIds.length),
    },
    collected_information: {
      shipping_details: {
        name: 'Test Buyer',
        address: { line1: '123 Test St', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
      },
    },
  };
}

function setupTransactionMock(listings: any[]) {
  // Reset tx mocks
  Object.values(mockTx).forEach((model: any) => {
    Object.values(model).forEach((fn: any) => {
      if (typeof fn.mockReset === 'function') fn.mockReset();
    });
  });

  // tx.listings.findUnique returns the matching listing
  mockTx.listings.findUnique.mockImplementation(({ where }: any) =>
    listings.find(l => l.id === where.id) || null
  );
  // tx.listings.findMany for shipping lookup
  mockTx.listings.findMany.mockResolvedValue(
    listings.map(l => ({ id: l.id, seller_id: l.seller_id, shipping_cost: l.shipping_cost }))
  );
  // tx.listings.update (stock decrement)
  mockTx.listings.update.mockResolvedValue({});
  // tx.listings.updateMany (stock guard)
  mockTx.listings.updateMany.mockResolvedValue({ count: 1 });
  // tx.orders.create
  mockTx.orders.create.mockImplementation(({ data }: any) => ({
    id: `order_${data.listing_id}`,
    listing_id: data.listing_id,
    quantity: data.quantity || 1,
    ...data,
  }));
  // tx.cart_items.deleteMany
  mockTx.cart_items.deleteMany.mockResolvedValue({ count: 0 });
  // tx.offers.update
  mockTx.offers.update.mockResolvedValue({});

  // $transaction executes the callback with our mock tx
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// CART PARTIAL CLEAR — fulfillCartOrder (Stripe Checkout path)
// ═══════════════════════════════════════════════════════════════════════════

describe('SC-04: cart clear in fulfillCartOrder is listing-scoped', () => {

  test('per-seller fulfilment deletes only that seller\'s listing_ids from cart', async () => {
    const sellerAListings = [
      fakeListing('lst_a1', 'seller_A', '60'),
      fakeListing('lst_a2', 'seller_A', '40'),
    ];

    // Prisma outer queries
    mockPrisma.listings.findMany.mockResolvedValue(sellerAListings);
    mockPrisma.orders.findMany.mockResolvedValue([]); // no idempotency hit
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'notif_1' });

    setupTransactionMock(sellerAListings);

    const session = fakeSession({
      listingIds: ['lst_a1', 'lst_a2'],
      sellerIds: ['seller_A'],
      type: 'seller_checkout',
    });

    await CartCheckoutController.fulfillCartOrder(session as any);

    // The deleteMany inside the transaction should scope to ONLY seller A's listing IDs
    expect(mockTx.cart_items.deleteMany).toHaveBeenCalledWith({
      where: {
        user_id: 'buyer_1',
        listing_id: { in: ['lst_a1', 'lst_a2'] },
      },
    });

    // Seller B's hypothetical listings (lst_b1, lst_b2) are NOT in the delete
    const deleteCall = mockTx.cart_items.deleteMany.mock.calls[0][0];
    expect(deleteCall.where.listing_id.in).not.toContain('lst_b1');
    expect(deleteCall.where.listing_id.in).not.toContain('lst_b2');
  });

  test('combined cart fulfilment deletes ALL fulfilled listing_ids (cart fully cleared)', async () => {
    const allListings = [
      fakeListing('lst_a1', 'seller_A', '60'),
      fakeListing('lst_b1', 'seller_B', '80'),
    ];

    mockPrisma.listings.findMany.mockResolvedValue(allListings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'notif_1' });

    setupTransactionMock(allListings);

    const session = fakeSession({
      listingIds: ['lst_a1', 'lst_b1'],
      sellerIds: ['seller_A', 'seller_B'],
      type: 'cart_checkout',
    });

    await CartCheckoutController.fulfillCartOrder(session as any);

    expect(mockTx.cart_items.deleteMany).toHaveBeenCalledWith({
      where: {
        user_id: 'buyer_1',
        listing_id: { in: ['lst_a1', 'lst_b1'] },
      },
    });
  });

  test('replayed fulfilment (items already gone) is a no-op, not an error', async () => {
    const listings = [fakeListing('lst_a1', 'seller_A')];

    mockPrisma.listings.findMany.mockResolvedValue(listings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_1', email: 'buyer@test.com', display_name: 'Buyer',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'notif_1' });

    setupTransactionMock(listings);
    // deleteMany returns count 0 (no rows deleted — items already cleared)
    mockTx.cart_items.deleteMany.mockResolvedValue({ count: 0 });

    const session = fakeSession({
      listingIds: ['lst_a1'],
      sellerIds: ['seller_A'],
    });

    // Should not throw
    await expect(
      CartCheckoutController.fulfillCartOrder(session as any)
    ).resolves.not.toThrow();
  });

  test('delete always includes buyer user_id (never clears another user\'s cart)', async () => {
    const listings = [fakeListing('lst_a1', 'seller_A')];

    mockPrisma.listings.findMany.mockResolvedValue(listings);
    mockPrisma.orders.findMany.mockResolvedValue([]);
    mockPrisma.users.findUnique.mockResolvedValue({
      id: 'buyer_42', email: 'b42@test.com', display_name: 'B42',
    });
    mockPrisma.notifications.create.mockResolvedValue({ id: 'notif_1' });

    setupTransactionMock(listings);

    const session = fakeSession({
      listingIds: ['lst_a1'],
      sellerIds: ['seller_A'],
      buyerId: 'buyer_42',
    });

    await CartCheckoutController.fulfillCartOrder(session as any);

    const deleteCall = mockTx.cart_items.deleteMany.mock.calls[0][0];
    expect(deleteCall.where.user_id).toBe('buyer_42');
  });
});
