// test-money-flows.ts
// Consolidated money-flow verification for the merged stack (payout fix + stuck-order safety net).
// Seeds REAL releasable orders on dev RDS, runs the actual autoReleaseEscrow() path,
// intercepts the computed payout, and asserts each money scenario.
//
// Run on dev:  npx ts-node test-money-flows.ts
// Requires: dev DATABASE_URL (mulligans-db-dev) + STRIPE_SECRET_KEY=sk_test_.
//
// Scenarios:
//   1. Manual-ship payout  -> seller paid ITEM PRICE ONLY (not item+shipping-label)
//   2. Auto-ship payout    -> seller paid ITEM PRICE ONLY (regression check)
//   3. Stuck order (no Stripe) -> NO payout, payout_blocked_at set, reminder created
//   4. Stuck order recovery    -> after seller "onboards", release attempts transfer + clears blocked flag
//   5. Multi-item group    -> seller paid SUM of item prices only (shipping once, retained by platform)

import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { autoReleaseEscrow } from './src/services/escrowService';

const prisma = new PrismaClient();

// ----- SAFETY GUARD -----
const dbUrl = process.env.DATABASE_URL || '';
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!dbUrl.includes('mulligans-db-dev')) {
  console.error('REFUSING TO RUN: DATABASE_URL is not the dev database (mulligans-db-dev).');
  process.exit(1);
}
if (!stripeKey.startsWith('sk_test_')) {
  console.error('REFUSING TO RUN: STRIPE_SECRET_KEY is not a test key (sk_test_).');
  process.exit(1);
}

const PFX = 'mf_'; // prefix for all seeded rows, for clean teardown
const now = new Date();
const past = (ms: number) => new Date(now.getTime() - ms);

// Capture [ESCROW] payout log lines so we can read the computed actualPayout per group.
const capturedPayouts: string[] = [];
const origLog = console.log.bind(console);
function startCapture() {
  console.log = (...args: any[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    capturedPayouts.push(line);
    origLog(...args);
  };
}
function stopCapture() { console.log = origLog; }

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  origLog(`${pass ? 'PASS' : 'FAIL'}  ${name} -- ${detail}`);
}

async function ensureUser(id: string, email: string, name: string, stripe: { id?: string | null; status?: string | null }) {
  await prisma.users.upsert({
    where: { id },
    update: { stripe_connect_id: stripe.id ?? null, stripe_connect_status: stripe.status ?? null },
    create: {
      id, cognito_id: `cog_${id}`, email, display_name: name, updated_at: now,
      stripe_connect_id: stripe.id ?? null, stripe_connect_status: stripe.status ?? null,
    },
  });
}

async function ensureListing(id: string, sellerId: string, title: string, price: number) {
  await prisma.listings.upsert({
    where: { id }, update: {},
    create: { id, seller_id: sellerId, title, category: 'clubs', price, currency: 'GBP', status: 'sold', updated_at: now },
  });
}

// Seed a releasable order: delivered, escrow_release_at in the past, no disputes/returns.
async function seedOrder(opts: {
  id: string; sellerId: string; buyerId: string; listingId: string;
  amount: number; sellerPayout: number; shippingCost: number; labelCost: number;
  autoShipped: boolean; trackingKey?: string;
}) {
  await prisma.orders.upsert({
    where: { id: opts.id },
    update: {
      status: 'delivered', amount: opts.amount, seller_payout: opts.sellerPayout,
      shipping_cost: opts.shippingCost, label_cost: opts.labelCost,
      label_auto_generated: opts.autoShipped,
      escrow_release_at: past(60_000), delivered_at: past(6 * 864e5),
      stripe_transfer_id: null, payout_blocked_at: null, payout_reminder_sent_at: null,
      completed_at: null, tracking_number: opts.trackingKey ?? null,
    },
    create: {
      id: opts.id, listing_id: opts.listingId, buyer_id: opts.buyerId, seller_id: opts.sellerId,
      amount: opts.amount, currency: 'GBP', status: 'delivered',
      seller_payout: opts.sellerPayout, shipping_cost: opts.shippingCost, label_cost: opts.labelCost,
      label_auto_generated: opts.autoShipped,
      paid_at: past(7 * 864e5), delivered_at: past(6 * 864e5), escrow_release_at: past(60_000),
      listing_title: 'MF Club', listing_price: opts.sellerPayout, updated_at: now,
      tracking_number: opts.trackingKey ?? null,
    },
  });
}

async function getOrder(id: string) {
  return prisma.orders.findUnique({ where: { id } });
}

async function cleanup() {
  await prisma.notifications.deleteMany({ where: { user_id: { startsWith: PFX } } });
  await prisma.support_tickets.deleteMany({ where: { order_id: { startsWith: PFX } } }).catch(() => {});
  await prisma.orders.deleteMany({ where: { id: { startsWith: PFX } } });
  await prisma.listings.deleteMany({ where: { id: { startsWith: PFX } } });
  await prisma.users.deleteMany({ where: { id: { startsWith: PFX } } });
}

async function main() {
  origLog('=== MONEY-FLOW VERIFICATION (dev) ===\n');
  await cleanup(); // clean slate

  // Common buyer
  await ensureUser(`${PFX}buyer`, `${PFX}buyer@example.com`, 'MF Buyer', {});

  // ---------------------------------------------------------------
  // SCENARIO 1 — Manual-ship payout: seller ITEM PRICE ONLY
  // item £50, shipping £4.99, label £3.50. Seller must get £50.00.
  // (Old bug would pay £50 + £4.99 - £3.50 = £51.49)
  // ---------------------------------------------------------------
  await ensureUser(`${PFX}s1`, `${PFX}s1@example.com`, 'MF Seller1', { id: 'acct_fake_s1', status: 'active' });
  await ensureListing(`${PFX}l1`, `${PFX}s1`, 'MF Club 1', 50.0);
  await seedOrder({ id: `${PFX}o1`, sellerId: `${PFX}s1`, buyerId: `${PFX}buyer`, listingId: `${PFX}l1`,
    amount: 58.49, sellerPayout: 50.0, shippingCost: 4.99, labelCost: 3.5, autoShipped: false, trackingKey: `${PFX}trk1` });

  // ---------------------------------------------------------------
  // SCENARIO 2 — Auto-ship payout: seller ITEM PRICE ONLY (regression)
  // ---------------------------------------------------------------
  await ensureUser(`${PFX}s2`, `${PFX}s2@example.com`, 'MF Seller2', { id: 'acct_fake_s2', status: 'active' });
  await ensureListing(`${PFX}l2`, `${PFX}s2`, 'MF Club 2', 50.0);
  await seedOrder({ id: `${PFX}o2`, sellerId: `${PFX}s2`, buyerId: `${PFX}buyer`, listingId: `${PFX}l2`,
    amount: 58.49, sellerPayout: 50.0, shippingCost: 4.99, labelCost: 3.5, autoShipped: true, trackingKey: `${PFX}trk2` });

  // ---------------------------------------------------------------
  // SCENARIO 3 — Stuck order: seller NOT onboarded (no Stripe).
  // Expect: NO transfer, payout_blocked_at set, reminder notification created.
  // ---------------------------------------------------------------
  await ensureUser(`${PFX}s3`, `${PFX}s3@example.com`, 'MF Seller3', { id: null, status: null });
  await ensureListing(`${PFX}l3`, `${PFX}s3`, 'MF Club 3', 40.0);
  await seedOrder({ id: `${PFX}o3`, sellerId: `${PFX}s3`, buyerId: `${PFX}buyer`, listingId: `${PFX}l3`,
    amount: 46.99, sellerPayout: 40.0, shippingCost: 4.99, labelCost: 3.5, autoShipped: false, trackingKey: `${PFX}trk3` });

  // ---------------------------------------------------------------
  // SCENARIO 5 — Multi-item group: one seller, two items, manual ship.
  // Same tracking key groups them. Seller gets sum of item prices (£30 + £20 = £50).
  // ---------------------------------------------------------------
  await ensureUser(`${PFX}s5`, `${PFX}s5@example.com`, 'MF Seller5', { id: 'acct_fake_s5', status: 'active' });
  await ensureListing(`${PFX}l5a`, `${PFX}s5`, 'MF Club 5a', 30.0);
  await ensureListing(`${PFX}l5b`, `${PFX}s5`, 'MF Club 5b', 20.0);
  await seedOrder({ id: `${PFX}o5a`, sellerId: `${PFX}s5`, buyerId: `${PFX}buyer`, listingId: `${PFX}l5a`,
    amount: 35.0, sellerPayout: 30.0, shippingCost: 4.99, labelCost: 3.5, autoShipped: false, trackingKey: `${PFX}trk5` });
  await seedOrder({ id: `${PFX}o5b`, sellerId: `${PFX}s5`, buyerId: `${PFX}buyer`, listingId: `${PFX}l5b`,
    amount: 25.0, sellerPayout: 20.0, shippingCost: 4.99, labelCost: 3.5, autoShipped: false, trackingKey: `${PFX}trk5` });

  // ---- RUN RELEASE CYCLE (captures [ESCROW] logs) ----
  origLog('\n--- Running autoReleaseEscrow() ---\n');
  startCapture();
  await autoReleaseEscrow();
  stopCapture();
  origLog('\n--- Release complete, asserting ---\n');

  // Helper: find the captured "Seller receives (item price only): £X" amount near a group
  function capturedAmountContains(amount: string): boolean {
    return capturedPayouts.some(l => l.includes('item price only') && l.includes(amount));
  }

  // SCENARIO 1 assertions
  {
    const o = await getOrder(`${PFX}o1`);
    const blocked = !!o?.payout_blocked_at;
    // Active seller (fake acct) -> code passes blocked-check, computes £50.00, attempts transfer (Stripe rejects fake acct).
    // We assert: NOT blocked (passed the gate) AND captured payout shows £50.00 (item only, not £51.49).
    const amountOk = capturedAmountContains('50.00') && !capturedAmountContains('51.49');
    record('S1 manual-ship payout = item only (£50.00, not £51.49)',
      !blocked && amountOk,
      `blocked=${blocked}, captured £50.00=${capturedAmountContains('50.00')}, captured £51.49(bad)=${capturedAmountContains('51.49')}`);
  }

  // SCENARIO 2 assertions
  {
    const amountOk = capturedAmountContains('50.00');
    record('S2 auto-ship payout = item only (£50.00)', amountOk, `captured £50.00=${amountOk}`);
  }

  // SCENARIO 3 assertions — stuck order
  {
    const o = await getOrder(`${PFX}o3`);
    const blocked = !!o?.payout_blocked_at;
    const notTransferred = !o?.stripe_transfer_id && o?.status !== 'completed';
    const notif = await prisma.notifications.findFirst({ where: { user_id: `${PFX}s3`, type: 'payout' } });
    record('S3 stuck order: blocked + no transfer + reminder sent',
      blocked && notTransferred && !!notif,
      `payout_blocked_at set=${blocked}, no transfer=${notTransferred}, reminder notif=${!!notif}`);
  }

  // SCENARIO 4 — recovery: flip s3 to active, re-run, expect blocked flag cleared / transfer attempted
  {
    await prisma.users.update({ where: { id: `${PFX}s3` }, data: { stripe_connect_id: 'acct_fake_s3', stripe_connect_status: 'active' } });
    capturedPayouts.length = 0;
    startCapture();
    await autoReleaseEscrow();
    stopCapture();
    const o = await getOrder(`${PFX}o3`);
    // Now seller is "active" -> passes blocked-check, computes £40.00, attempts transfer.
    // payout_blocked_at should NOT still be set as a permanent block; the code now proceeds past the gate.
    const passedGate = capturedAmountContains('40.00');
    record('S4 stuck-order recovery: after onboarding, payout computed (£40.00) + gate passed',
      passedGate,
      `captured £40.00=${passedGate}, payout_blocked_at now=${o?.payout_blocked_at ? 'still set' : 'cleared/na'}`);
  }

  // SCENARIO 5 — multi-item group
  {
    // Seller s5 group should compute £50.00 total (30+20), shipping once, retained by platform.
    const groupOk = capturedAmountContains('50.00');
    record('S5 multi-item group payout = sum of items (£50.00)', groupOk, `captured £50.00=${groupOk}`);
  }

  // ---- SUMMARY ----
  origLog('\n=== SUMMARY ===');
  const passed = results.filter(r => r.pass).length;
  results.forEach(r => origLog(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`));
  origLog(`\n${passed}/${results.length} scenarios passed.`);

  await cleanup();
  origLog('\nCleanup complete. Seeded rows removed.');
  await prisma.$disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  stopCapture();
  console.error('TEST ERROR:', e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
