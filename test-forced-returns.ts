// test-forced-returns.ts
// Dev verification for Brief 3b (forced returns). Seeds real return_requests on dev RDS
// in various states, runs the actual cron paths, and asserts the money outcomes.
//
// Run on dev:  npx ts-node test-forced-returns.ts
// Requires: dev DATABASE_URL (mulligans-db-dev) + STRIPE_SECRET_KEY=sk_test_.
//
// Scenarios:
//   T1  isForceReturnThreshold pure math (45/50 = true, 30/50 = false, 35/50 = true)
//   T2  auto-confirm: shipped + delivered_at 4d ago        -> refund ITEM COST, completed, order returned
//   T3  auto-confirm fallback: shipped + delivered null, shipped_at 15d ago -> auto-confirms
//   T4  not-yet-due guard: shipped + delivered_at 1d ago   -> does NOT auto-confirm (stays shipped)
//   T5  idempotency: run auto-confirm twice                -> only ONE refund (claim-the-row + idempotency key)
//   T6  buyer-didn't-ship timeout: label_created + deadline past -> autoExpireReturns cancels, order back to delivered
//   T7  refund AMOUNT = item cost (£50), NOT buyer total (£58.49)  [Fix 1 proof]

import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { autoConfirmForcedReturns, autoExpireReturns } from './src/services/escrowService';
import { isForceReturnThreshold } from './src/services/forcedReturnService';
import Stripe from 'stripe';

const prisma = new PrismaClient();

// ----- SAFETY GUARD -----
const dbUrl = process.env.DATABASE_URL || '';
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!dbUrl.includes('mulligans-db-dev')) { console.error('REFUSING: not dev DB'); process.exit(1); }
if (!stripeKey.startsWith('sk_test_')) { console.error('REFUSING: not test Stripe key'); process.exit(1); }

const stripe = new Stripe(stripeKey, { apiVersion: '2025-11-17.clover' as any });
const PFX = 'fr_';
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 864e5);

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const rec = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} -- ${detail}`);
};

async function ensureUser(id: string, email: string) {
  await prisma.users.upsert({
    where: { id }, update: {},
    create: { id, cognito_id: `cog_${id}`, email, display_name: id, updated_at: now },
  });
}
async function ensureListing(id: string, sellerId: string, price: number) {
  await prisma.listings.upsert({
    where: { id }, update: { status: 'sold' },
    create: { id, seller_id: sellerId, title: 'FR Club', category: 'clubs', price, currency: 'GBP', status: 'sold', updated_at: now },
  });
}

// Seed an order + a forced return in a given state. Returns {orderId, returnId}.
async function seedForcedReturn(opts: {
  key: string; itemCost: number; buyerTotal: number;
  returnStatus: string; deliveredAt?: Date | null; shippedAt?: Date | null;
  returnShipDeadline?: Date | null; withRealPI?: boolean;
}) {
  const sellerId = `${PFX}s_${opts.key}`;
  const buyerId = `${PFX}b_${opts.key}`;
  const listingId = `${PFX}l_${opts.key}`;
  const orderId = `${PFX}o_${opts.key}`;
  const returnId = `${PFX}r_${opts.key}`;

  await ensureUser(sellerId, `${sellerId}@example.com`);
  await ensureUser(buyerId, `${buyerId}@example.com`);
  await ensureListing(listingId, sellerId, opts.itemCost);

  // Real test PI so refunds can actually be created in test mode
  let piId: string | null = null;
  if (opts.withRealPI) {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(opts.buyerTotal * 100), currency: 'gbp',
      payment_method: 'pm_card_visa', confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    piId = pi.id;
  }

  await prisma.orders.upsert({
    where: { id: orderId },
    update: { status: 'delivered', amount: opts.buyerTotal, seller_payout: opts.itemCost, stripe_payment_intent_id: piId, refunded_at: null, stripe_refund_id: null },
    create: {
      id: orderId, listing_id: listingId, buyer_id: buyerId, seller_id: sellerId,
      amount: opts.buyerTotal, seller_payout: opts.itemCost, currency: 'GBP', status: 'delivered',
      stripe_payment_intent_id: piId, listing_title: 'FR Club', listing_price: opts.itemCost,
      paid_at: daysAgo(20), delivered_at: daysAgo(18), updated_at: now,
    },
  });

  await prisma.return_requests.upsert({
    where: { id: returnId },
    update: {
      status: opts.returnStatus, is_forced: true, refund_amount: opts.itemCost,
      delivered_at: opts.deliveredAt ?? null, shipped_at: opts.shippedAt ?? null,
      return_ship_deadline: opts.returnShipDeadline ?? null,
      stripe_refund_id: null, completed_at: null,
      return_tracking_number: `${PFX}trk_${opts.key}`,
    },
    create: {
      id: returnId, order_id: orderId, requested_by: buyerId, approved_by: 'system',
      reason: 'forced_return_high_value_refund', status: opts.returnStatus, is_forced: true,
      refund_amount: opts.itemCost, shipping_deducted: 0,
      delivered_at: opts.deliveredAt ?? null, shipped_at: opts.shippedAt ?? null,
      return_ship_deadline: opts.returnShipDeadline ?? null,
      return_tracking_number: `${PFX}trk_${opts.key}`,
      created_at: now, updated_at: now,
    },
  });

  return { orderId, returnId, sellerId, buyerId };
}

async function cleanup() {
  await prisma.notifications.deleteMany({ where: { user_id: { startsWith: PFX } } });
  await prisma.support_tickets.deleteMany({ where: { user_id: { startsWith: PFX } } }).catch(() => {});
  await prisma.return_requests.deleteMany({ where: { id: { startsWith: PFX } } });
  await prisma.orders.deleteMany({ where: { id: { startsWith: PFX } } });
  await prisma.listings.deleteMany({ where: { id: { startsWith: PFX } } });
  await prisma.users.deleteMany({ where: { id: { startsWith: PFX } } });
}

async function main() {
  console.log('=== FORCED-RETURN VERIFICATION (dev) ===\n');
  await cleanup();

  // ---- T1: threshold pure math ----
  {
    const a = isForceReturnThreshold(45, 50); // 90% -> true
    const b = isForceReturnThreshold(30, 50); // 60% -> false
    const c = isForceReturnThreshold(35, 50); // 70% -> true (boundary)
    rec('T1 threshold math (45/50=T, 30/50=F, 35/50=T)', a === true && b === false && c === true, `a=${a} b=${b} c=${c}`);
  }

  // ---- T2: auto-confirm, delivered 4 days ago ----
  {
    const { returnId, orderId } = await seedForcedReturn({ key: 't2', itemCost: 50, buyerTotal: 58.49, returnStatus: 'shipped', deliveredAt: daysAgo(4), shippedAt: daysAgo(6), withRealPI: true });
    await autoConfirmForcedReturns();
    const r = await prisma.return_requests.findUnique({ where: { id: returnId } });
    const o = await prisma.orders.findUnique({ where: { id: orderId } });
    const ok = r?.status === 'completed' && !!r?.stripe_refund_id && o?.status === 'returned';
    rec('T2 auto-confirm (delivered+4d) -> completed + refund + order returned', ok, `return=${r?.status}, refundId=${r?.stripe_refund_id ? 'set' : 'null'}, order=${o?.status}`);
  }

  // ---- T3: fallback, no delivered_at, shipped 15 days ago ----
  {
    const { returnId } = await seedForcedReturn({ key: 't3', itemCost: 40, buyerTotal: 46.99, returnStatus: 'shipped', deliveredAt: null, shippedAt: daysAgo(15), withRealPI: true });
    await autoConfirmForcedReturns();
    const r = await prisma.return_requests.findUnique({ where: { id: returnId } });
    rec('T3 fallback (shipped+15d, no delivery) -> auto-confirms', r?.status === 'completed' && !!r?.stripe_refund_id, `return=${r?.status}, refundId=${r?.stripe_refund_id ? 'set' : 'null'}`);
  }

  // ---- T4: not-yet-due, delivered 1 day ago ----
  {
    const { returnId } = await seedForcedReturn({ key: 't4', itemCost: 50, buyerTotal: 58.49, returnStatus: 'shipped', deliveredAt: daysAgo(1), shippedAt: daysAgo(2), withRealPI: false });
    await autoConfirmForcedReturns();
    const r = await prisma.return_requests.findUnique({ where: { id: returnId } });
    rec('T4 not-yet-due (delivered+1d) -> stays shipped (no premature confirm)', r?.status === 'shipped' && !r?.stripe_refund_id, `return=${r?.status}`);
  }

  // ---- T5: idempotency, run twice ----
  {
    const { returnId, orderId } = await seedForcedReturn({ key: 't5', itemCost: 50, buyerTotal: 58.49, returnStatus: 'shipped', deliveredAt: daysAgo(4), shippedAt: daysAgo(6), withRealPI: true });
    await autoConfirmForcedReturns();
    const after1 = await prisma.return_requests.findUnique({ where: { id: returnId } });
    const refund1 = after1?.stripe_refund_id;
    await autoConfirmForcedReturns(); // second run
    const after2 = await prisma.return_requests.findUnique({ where: { id: returnId } });
    // Refund id unchanged, status still completed, order not double-refunded
    const ok = !!refund1 && after2?.stripe_refund_id === refund1 && after2?.status === 'completed';
    rec('T5 idempotency (run twice) -> single refund, no double-process', ok, `refund1=${refund1 ? 'set' : 'null'}, refund2=${after2?.stripe_refund_id === refund1 ? 'same' : 'CHANGED'}`);
  }

  // ---- T6: buyer-didn't-ship timeout ----
  {
    const { returnId, orderId } = await seedForcedReturn({ key: 't6', itemCost: 50, buyerTotal: 58.49, returnStatus: 'label_created', returnShipDeadline: daysAgo(1), withRealPI: false });
    await autoExpireReturns();
    const r = await prisma.return_requests.findUnique({ where: { id: returnId } });
    const o = await prisma.orders.findUnique({ where: { id: orderId } });
    // Expired returns are cancelled; order goes back to delivered (seller will be paid), no refund
    const ok = (r?.status === 'cancelled' || r?.status === 'expired') && !r?.stripe_refund_id;
    rec('T6 buyer-didnt-ship timeout -> return cancelled, no refund', ok, `return=${r?.status}, order=${o?.status}, refundId=${r?.stripe_refund_id ? 'set' : 'null'}`);
  }

  // ---- T7: refund AMOUNT = item cost (Fix 1 proof) ----
  {
    const { orderId } = await seedForcedReturn({ key: 't7', itemCost: 50, buyerTotal: 58.49, returnStatus: 'shipped', deliveredAt: daysAgo(4), shippedAt: daysAgo(6), withRealPI: true });
    await autoConfirmForcedReturns();
    const o = await prisma.orders.findUnique({ where: { id: orderId } });
    const refunded = parseFloat(o?.refund_amount?.toString() || '0');
    // Must be the ITEM COST (50.00), NOT the buyer total (58.49)
    const ok = Math.abs(refunded - 50.0) < 0.001 && Math.abs(refunded - 58.49) > 0.001;
    rec('T7 refund = item cost £50.00, NOT buyer total £58.49 [Fix 1]', ok, `refund_amount=£${refunded.toFixed(2)}`);
  }

  // ---- SUMMARY ----
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.pass).length;
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`));
  console.log(`\n${passed}/${results.length} scenarios passed.`);

  await cleanup();
  console.log('\nCleanup complete. Seeded rows removed.');
  await prisma.$disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('TEST ERROR:', e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});