#!/usr/bin/env npx ts-node
// scripts/seed-two-seller-cart.ts
//
// Seeds a 2-seller cart scenario on the DEV database for split-checkout testing.
// Run on dev EC2:  npx ts-node scripts/seed-two-seller-cart.ts
//
// Idempotent: uses upsert keyed on deterministic IDs with a unique prefix.
// Re-running clears prior seed rows (scoped to prefix only) and re-creates.

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, Prisma } from '@prisma/client';
import {
  calculateBuyerFees,
  BUYER_PROTECTION_RATE,
  SERVICE_FEE_PER_ITEM,
  INSURANCE_RATE,
  CART_ITEM_EXPIRY_HOURS,
} from '../src/lib/feeCalculations';

const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────
// SAFETY GUARDS (mandatory — script refuses to run if ANY guard fails)
// ──────────────────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl.includes('mulligans-db-dev')) {
  console.error('╔══════════════════════════════════════════════════════╗');
  console.error('║  REFUSING TO RUN: DATABASE_URL is NOT the dev DB.   ║');
  console.error('║  This script writes data and must only run on dev.  ║');
  console.error('╚══════════════════════════════════════════════════════╝');
  console.error(`DATABASE_URL starts with: ${dbUrl.slice(0, 40)}…`);
  process.exit(1);
}

console.log(`✓ Dev DB guard passed (DATABASE_URL contains "mulligans-db-dev")`);

// ──────────────────────────────────────────────────────────────────────
// SEED PREFIX — every seeded row uses this prefix for easy identification
// ──────────────────────────────────────────────────────────────────────

const PFX = 'seed_sc_';
const SEED_EMAIL_DOMAIN = '@seed.mulligans.test';
const now = new Date();

// ──────────────────────────────────────────────────────────────────────
// IDs — deterministic so the script is idempotent
// ──────────────────────────────────────────────────────────────────────

const BUYER_ID       = `${PFX}buyer_01`;
const SELLER_A_ID    = `${PFX}seller_a`;
const SELLER_B_ID    = `${PFX}seller_b`;

const LISTING_A1_ID  = `${PFX}la1_driver`;
const LISTING_A2_ID  = `${PFX}la2_irons`;
const LISTING_A3_ID  = `${PFX}la3_putter`;
const LISTING_B1_ID  = `${PFX}lb1_wedge`;
const LISTING_B2_ID  = `${PFX}lb2_bag`;

const CART_ITEM_1_ID = `${PFX}ci_1`;
const CART_ITEM_2_ID = `${PFX}ci_2`;
const CART_ITEM_3_ID = `${PFX}ci_3`;

// ──────────────────────────────────────────────────────────────────────
// LISTING DATA
// ──────────────────────────────────────────────────────────────────────

interface ListingDef {
  id: string;
  sellerId: string;
  title: string;
  category: string;
  brand: string;
  price: number;
  shippingCost: number;
  parcelSize: string;
  quantity: number;
  selectedSize?: string;
}

const LISTINGS: ListingDef[] = [
  {
    id: LISTING_A1_ID,
    sellerId: SELLER_A_ID,
    title: 'TaylorMade Qi35 Driver 10.5° Stiff',
    category: 'clubs',
    brand: 'TaylorMade',
    price: 349.99,
    shippingCost: 8.99,
    parcelSize: 'large',
    quantity: 1,
  },
  {
    id: LISTING_A2_ID,
    sellerId: SELLER_A_ID,
    title: 'Mizuno Pro 245 Irons 4-PW Stiff Steel',
    category: 'clubs',
    brand: 'Mizuno',
    price: 599.99,
    shippingCost: 12.99,
    parcelSize: 'large',
    quantity: 1,
    selectedSize: '4-PW',
  },
  {
    id: LISTING_A3_ID,
    sellerId: SELLER_A_ID,
    title: 'Scotty Cameron Special Select Newport 2',
    category: 'clubs',
    brand: 'Titleist',
    price: 189.99,
    shippingCost: 5.99,
    parcelSize: 'medium',
    quantity: 1,
  },
  {
    id: LISTING_B1_ID,
    sellerId: SELLER_B_ID,
    title: 'Callaway Jaws Full Toe 58° Wedge',
    category: 'clubs',
    brand: 'Callaway',
    price: 129.99,
    shippingCost: 5.99,
    parcelSize: 'medium',
    quantity: 2,
  },
  {
    id: LISTING_B2_ID,
    sellerId: SELLER_B_ID,
    title: 'Titleist Players 4 StaDry Stand Bag',
    category: 'bags',
    brand: 'Titleist',
    price: 179.99,
    shippingCost: 14.99,
    parcelSize: 'extra_large',
    quantity: 1,
  },
];

// CART: 2 items from seller A, 1 from seller B
const CART_ITEMS: Array<{
  id: string;
  listingId: string;
  selectedSize: string | null;
}> = [
  { id: CART_ITEM_1_ID, listingId: LISTING_A1_ID, selectedSize: null },
  { id: CART_ITEM_2_ID, listingId: LISTING_A2_ID, selectedSize: '4-PW' },
  { id: CART_ITEM_3_ID, listingId: LISTING_B1_ID, selectedSize: null },
];

// ──────────────────────────────────────────────────────────────────────
// CLEANUP — remove prior seed rows (FK-order safe)
// ──────────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n🧹 Cleaning up prior seed rows…');
  const deleted = {
    cart_items: 0,
    notifications: 0,
    listings: 0,
    users: 0,
  };

  deleted.cart_items = (await prisma.cart_items.deleteMany({
    where: { id: { startsWith: PFX } },
  })).count;

  deleted.notifications = (await prisma.notifications.deleteMany({
    where: { user_id: { startsWith: PFX } },
  })).count;

  // Orders, return_requests, etc. should not exist for seed users, but guard
  await prisma.orders.deleteMany({ where: { buyer_id: { startsWith: PFX } } });
  await prisma.orders.deleteMany({ where: { seller_id: { startsWith: PFX } } });

  deleted.listings = (await prisma.listings.deleteMany({
    where: { id: { startsWith: PFX } },
  })).count;

  deleted.users = (await prisma.users.deleteMany({
    where: { id: { startsWith: PFX } },
  })).count;

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(`   Removed: ${JSON.stringify(deleted)}`);
  } else {
    console.log('   (no prior seed rows found)');
  }
}

// ──────────────────────────────────────────────────────────────────────
// SEED HELPERS
// ──────────────────────────────────────────────────────────────────────

async function seedUser(id: string, name: string, email: string, opts?: {
  stripeConnectId?: string;
  isVerifiedSeller?: boolean;
}) {
  await prisma.users.upsert({
    where: { id },
    update: {
      display_name: name,
      email,
      updated_at: now,
      stripe_connect_id: opts?.stripeConnectId ?? null,
      stripe_connect_status: opts?.stripeConnectId ? 'active' : null,
      is_verified_seller: opts?.isVerifiedSeller ?? false,
    },
    create: {
      id,
      cognito_id: `cog_${id}`,
      email,
      display_name: name,
      updated_at: now,
      stripe_connect_id: opts?.stripeConnectId ?? null,
      stripe_connect_status: opts?.stripeConnectId ? 'active' : null,
      is_verified_seller: opts?.isVerifiedSeller ?? false,
      location: 'London, UK',
      bio: `Seed test account (${name})`,
    },
  });
}

async function seedListing(def: ListingDef) {
  await prisma.listings.upsert({
    where: { id: def.id },
    update: {
      title: def.title,
      price: new Prisma.Decimal(def.price),
      shipping_cost: new Prisma.Decimal(def.shippingCost),
      parcel_size: def.parcelSize,
      quantity: def.quantity,
      status: 'active',
      updated_at: now,
    },
    create: {
      id: def.id,
      seller_id: def.sellerId,
      title: def.title,
      category: def.category,
      brand: def.brand,
      price: new Prisma.Decimal(def.price),
      currency: 'GBP',
      status: 'active',
      shipping_cost: new Prisma.Decimal(def.shippingCost),
      parcel_size: def.parcelSize,
      quantity: def.quantity,
      updated_at: now,
      condition_overall: 8,
    },
  });
}

async function seedCartItem(
  id: string,
  buyerId: string,
  listingId: string,
  selectedSize: string | null,
) {
  const expiresAt = new Date(now.getTime() + CART_ITEM_EXPIRY_HOURS * 3600_000);

  // Use delete+create instead of upsert — the compound unique
  // (user_id, listing_id, selected_size) has a nullable field
  // which complicates Prisma upsert. Cleanup already ran, so
  // this is safe.
  await prisma.cart_items.deleteMany({
    where: { id },
  });

  await prisma.cart_items.create({
    data: {
      id,
      user_id: buyerId,
      listing_id: listingId,
      expires_at: expiresAt,
      quantity: 1,
      selected_size: selectedSize,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SEED: Two-Seller Cart for Split-Checkout Testing');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Cleanup
  await cleanup();

  // 2. Seed users
  console.log('\n👤 Seeding users…');

  await seedUser(BUYER_ID, 'Test Buyer', `buyer${SEED_EMAIL_DOMAIN}`);
  console.log(`   Buyer:    ${BUYER_ID} <buyer${SEED_EMAIL_DOMAIN}>`);

  // NOTE: Stripe Connect accounts are NOT created by this script.
  // On the dev environment, these users need valid test-mode Stripe Connect
  // accounts for checkout to complete. If they don't exist, the per-seller
  // checkout endpoints will fail at the Stripe session/PI creation step.
  // See FLAG in questions.md for how to handle this.
  await seedUser(SELLER_A_ID, 'Seed Seller A — Pro Shop Demo', `seller.a${SEED_EMAIL_DOMAIN}`, {
    isVerifiedSeller: true,
  });
  console.log(`   Seller A: ${SELLER_A_ID} <seller.a${SEED_EMAIL_DOMAIN}>`);

  await seedUser(SELLER_B_ID, 'Seed Seller B — Weekend Golfer', `seller.b${SEED_EMAIL_DOMAIN}`, {
    isVerifiedSeller: true,
  });
  console.log(`   Seller B: ${SELLER_B_ID} <seller.b${SEED_EMAIL_DOMAIN}>`);

  // 3. Seed listings
  console.log('\n📦 Seeding listings…');
  for (const def of LISTINGS) {
    await seedListing(def);
    const seller = def.sellerId === SELLER_A_ID ? 'A' : 'B';
    console.log(`   [Seller ${seller}] ${def.title}  — £${def.price.toFixed(2)} + £${def.shippingCost.toFixed(2)} shipping`);
  }

  // 4. Seed cart items
  console.log('\n🛒 Seeding cart items for buyer…');
  for (const ci of CART_ITEMS) {
    await seedCartItem(ci.id, BUYER_ID, ci.listingId, ci.selectedSize);
    const listing = LISTINGS.find(l => l.id === ci.listingId)!;
    const seller = listing.sellerId === SELLER_A_ID ? 'A' : 'B';
    console.log(`   Cart item: ${listing.title} (Seller ${seller})${ci.selectedSize ? ` [size: ${ci.selectedSize}]` : ''}`);
  }

  // 5. Print checkout summary
  printCheckoutSummary();

  // 6. Verify
  await verify();

  console.log('\n✅ Seed complete. Cart is ready for split-checkout testing.');
  console.log('══════════════════════════════════════════════════════════\n');
}

// ──────────────────────────────────────────────────────────────────────
// CHECKOUT SUMMARY — expected per-seller totals
// ──────────────────────────────────────────────────────────────────────

function printCheckoutSummary() {
  console.log('\n' + '─'.repeat(60));
  console.log('  EXPECTED PER-SELLER CHECKOUT TOTALS');
  console.log('─'.repeat(60));

  // Build cart items by seller
  const cartListingDefs = CART_ITEMS.map(ci => LISTINGS.find(l => l.id === ci.listingId)!);
  const sellerGroups: Record<string, ListingDef[]> = {};

  for (const def of cartListingDefs) {
    const key = def.sellerId === SELLER_A_ID ? 'Seller A' : 'Seller B';
    (sellerGroups[key] ??= []).push(def);
  }

  for (const [sellerLabel, items] of Object.entries(sellerGroups)) {
    console.log(`\n  ${sellerLabel}:`);

    const feeItems = items.map(i => ({
      sellerId: i.sellerId,
      listingPrice: i.price,
      quantity: 1,
      shippingCost: i.shippingCost,
    }));

    const fees = calculateBuyerFees(feeItems);

    for (const item of items) {
      console.log(`    • ${item.title}`);
      console.log(`      Price: £${item.price.toFixed(2)}  |  Shipping: £${item.shippingCost.toFixed(2)}`);
    }

    console.log(`    ┌─────────────────────────────────────────────┐`);
    console.log(`    │ Items total:          £${fees.itemsTotal.toFixed(2).padStart(8)}`);
    console.log(`    │ Shipping (max/seller): £${fees.baseShipping.toFixed(2).padStart(8)}`);
    console.log(`    │ Insurance (1.25%):    £${fees.insurancePremium.toFixed(2).padStart(8)}`);
    console.log(`    │ Buyer protection (7.5%): £${fees.buyerProtectionFee.toFixed(2).padStart(7)}`);
    console.log(`    │ Service fee:          £${fees.serviceFee.toFixed(2).padStart(8)}`);
    console.log(`    │─────────────────────────────────────────────│`);
    console.log(`    │ SELLER TOTAL:         £${fees.grandTotal.toFixed(2).padStart(8)}`);
    console.log(`    └─────────────────────────────────────────────┘`);
  }

  // Combined total
  const allFeeItems = cartListingDefs.map(i => ({
    sellerId: i.sellerId,
    listingPrice: i.price,
    quantity: 1,
    shippingCost: i.shippingCost,
  }));
  const combined = calculateBuyerFees(allFeeItems);

  console.log(`\n  Combined cart total (if single checkout): £${combined.grandTotal.toFixed(2)}`);
  console.log(`  Per-seller grand total (sum of seller checkouts): £${
    Object.values(sellerGroups).reduce((sum, items) => {
      const fees = calculateBuyerFees(items.map(i => ({
        sellerId: i.sellerId,
        listingPrice: i.price,
        quantity: 1,
        shippingCost: i.shippingCost,
      })));
      return sum + fees.grandTotal;
    }, 0).toFixed(2)
  }`);

  console.log('─'.repeat(60));
}

// ──────────────────────────────────────────────────────────────────────
// VERIFY — confirm rows were written correctly
// ──────────────────────────────────────────────────────────────────────

async function verify() {
  console.log('\n🔍 Verifying seed data…');

  const users = await prisma.users.count({ where: { id: { startsWith: PFX } } });
  const listings = await prisma.listings.count({ where: { id: { startsWith: PFX } } });
  const cartItems = await prisma.cart_items.count({ where: { id: { startsWith: PFX } } });

  const checks = [
    { name: '3 seed users',    ok: users === 3,     detail: `found ${users}` },
    { name: '5 seed listings', ok: listings === 5,   detail: `found ${listings}` },
    { name: '3 cart items',    ok: cartItems === 3,  detail: `found ${cartItems}` },
  ];

  // Verify cart items span 2 sellers
  const cartWithSellers = await prisma.cart_items.findMany({
    where: { id: { startsWith: PFX } },
    include: { listings: { select: { seller_id: true } } },
  });
  const distinctSellers = new Set(cartWithSellers.map(ci => ci.listings.seller_id));
  checks.push({
    name: 'Cart spans 2 sellers',
    ok: distinctSellers.size === 2,
    detail: `found ${distinctSellers.size} distinct seller(s)`,
  });

  // Verify expiry is in the future
  const futureExpiry = cartWithSellers.every(ci => ci.expires_at > now);
  checks.push({
    name: 'All cart items have future expires_at',
    ok: futureExpiry,
    detail: futureExpiry ? 'all future' : 'some expired!',
  });

  let allPass = true;
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    console.log(`   ${icon} ${c.name} — ${c.detail}`);
    if (!c.ok) allPass = false;
  }

  if (!allPass) {
    console.error('\n❌ Verification FAILED. Check the output above.');
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────────
// SUMMARY PRINT — buyer login details
// ──────────────────────────────────────────────────────────────────────

function printLoginInfo() {
  console.log('\n' + '═'.repeat(60));
  console.log('  HOW TO TEST');
  console.log('═'.repeat(60));
  console.log(`
  Buyer email:  buyer${SEED_EMAIL_DOMAIN}
  Buyer ID:     ${BUYER_ID}

  NOTE: This buyer exists in the DB only. To log in on the app,
  the buyer must also exist in AWS Cognito. Options:

    a) Use an existing dev user and manually add cart items
       pointing to the seeded listings (update BUYER_ID in the
       cart_items rows to match your Cognito user's DB id).

    b) Create "buyer${SEED_EMAIL_DOMAIN}" in Cognito dev
       pool manually (aws cli or console), then the DB row
       created by this script will be found on login.

    c) Sign up as this email on the dev app (the app's
       signup flow creates the Cognito + DB user, but will
       collide with the seeded DB row — delete the seed user
       row first, sign up, then re-run this script with the
       new user's DB id).

  ⚠ See output/questions.md for the full FLAG on buyer login.

  Sellers:
    Seller A: ${SELLER_A_ID} (seller.a${SEED_EMAIL_DOMAIN})
    Seller B: ${SELLER_B_ID} (seller.b${SEED_EMAIL_DOMAIN})

  ⚠ Sellers need test-mode Stripe Connect accounts for
    checkout to succeed. See questions.md for the FLAG.
  `);
}

// ──────────────────────────────────────────────────────────────────────
// ENTRYPOINT
// ──────────────────────────────────────────────────────────────────────

main()
  .then(() => {
    printLoginInfo();
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('\n❌ Seed script error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
