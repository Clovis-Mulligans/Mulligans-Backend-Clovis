#!/usr/bin/env npx ts-node
// backfill-autocancel.ts — Restore auto_cancel_at on stranded to_ship orders
//
// Usage:
//   npx ts-node scripts/backfill-autocancel.ts              # dry run (default)
//   npx ts-node scripts/backfill-autocancel.ts --apply       # write future-deadline rows only
//   npx ts-node scripts/backfill-autocancel.ts --apply-overdue  # write ALL rows including overdue
//
// ⚠️ LIVE MONEY: overdue rows trigger auto-cancel + refund on the next 02:00 cron run.
// --apply-overdue exists so Harry decides per-order, not the script.

import { PrismaClient } from '@prisma/client';
import { calculateShippingDeadline } from '../src/utils/shippingDeadline';

const prisma = new PrismaClient();

async function main() {
  const mode = process.argv[2] || '--dry-run';
  const applyFuture = mode === '--apply' || mode === '--apply-overdue';
  const applyOverdue = mode === '--apply-overdue';

  if (!['--dry-run', '--apply', '--apply-overdue'].includes(mode)) {
    console.error('Usage: npx ts-node scripts/backfill-autocancel.ts [--apply | --apply-overdue]');
    process.exit(1);
  }

  console.log(`\n=== backfill-autocancel.ts — mode: ${mode} ===\n`);

  const stranded = await prisma.orders.findMany({
    where: {
      status: 'to_ship',
      auto_cancel_at: null,
      refunded_at: null,
      cancelled_at: null,
    },
    select: {
      id: true,
      created_at: true,
      updated_at: true,
      amount: true,
      listing_title: true,
      tracking_number: true,
      label_url: true,
      buyer_id: true,
      seller_id: true,
      users_orders_seller_idTousers: {
        select: { email: true, display_name: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });

  if (stranded.length === 0) {
    console.log('No stranded orders found. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  const now = new Date();
  console.log(`Found ${stranded.length} stranded order(s):\n`);

  const rows: Array<{
    id: string;
    created: string;
    deadline: string;
    amount: string;
    seller: string;
    overdue: boolean;
  }> = [];

  for (const order of stranded) {
    const deadline = calculateShippingDeadline(order.created_at);
    const overdue = deadline.getTime() <= now.getTime();
    const sellerEmail = (order as any).users_orders_seller_idTousers?.email || 'unknown';
    const sellerName = (order as any).users_orders_seller_idTousers?.display_name || '';

    rows.push({
      id: order.id,
      created: order.created_at.toISOString().slice(0, 19),
      deadline: deadline.toISOString().slice(0, 19),
      amount: `£${parseFloat(order.amount?.toString() || '0').toFixed(2)}`,
      seller: `${sellerName} (${sellerEmail})`,
      overdue,
    });
  }

  // Print table
  console.log(
    'ID'.padEnd(44) +
    'Created'.padEnd(22) +
    'Deadline'.padEnd(22) +
    'Amount'.padEnd(10) +
    'Status'.padEnd(10) +
    'Seller'
  );
  console.log('-'.repeat(130));

  for (const row of rows) {
    console.log(
      row.id.padEnd(44) +
      row.created.padEnd(22) +
      row.deadline.padEnd(22) +
      row.amount.padEnd(10) +
      (row.overdue ? 'OVERDUE' : 'OK').padEnd(10) +
      row.seller
    );
  }

  const futureRows = rows.filter(r => !r.overdue);
  const overdueRows = rows.filter(r => r.overdue);

  console.log(`\nSummary: ${futureRows.length} within window, ${overdueRows.length} OVERDUE`);

  if (mode === '--dry-run') {
    console.log('\n--- DRY RUN — no changes written. Use --apply to write future-deadline rows. ---\n');
    await prisma.$disconnect();
    return;
  }

  // Apply future-deadline rows
  if (futureRows.length > 0 && applyFuture) {
    console.log(`\nWriting ${futureRows.length} future-deadline row(s)...`);
    for (const row of futureRows) {
      const order = stranded.find(o => o.id === row.id)!;
      const deadline = calculateShippingDeadline(order.created_at);
      const result = await prisma.orders.updateMany({
        where: { id: order.id, auto_cancel_at: null },
        data: { auto_cancel_at: deadline, updated_at: now },
      });
      if (result.count === 0) {
        console.log(`  ⚠ ${order.id} — skipped (auto_cancel_at already set since read)`);
      } else {
        console.log(`  ✓ ${order.id} → auto_cancel_at = ${deadline.toISOString()}`);
      }
    }
  }

  // Apply overdue rows only with explicit flag
  if (overdueRows.length > 0) {
    if (applyOverdue) {
      console.log(`\n⚠️  Writing ${overdueRows.length} OVERDUE row(s) — these will trigger auto-cancel on next cron run!`);
      for (const row of overdueRows) {
        const order = stranded.find(o => o.id === row.id)!;
        const deadline = calculateShippingDeadline(order.created_at);
        const result = await prisma.orders.updateMany({
          where: { id: order.id, auto_cancel_at: null },
          data: { auto_cancel_at: deadline, updated_at: now },
        });
        if (result.count === 0) {
          console.log(`  ⚠ ${order.id} — skipped (auto_cancel_at already set since read)`);
        } else {
          console.log(`  ⚠️ ${order.id} → auto_cancel_at = ${deadline.toISOString()} (OVERDUE — will auto-cancel)`);
        }
      }
    } else {
      console.log(`\n⚠️  ${overdueRows.length} OVERDUE row(s) skipped. Use --apply-overdue to write them.`);
      console.log('    These orders would be auto-cancelled and refunded on the next 02:00 cron run.');
      for (const row of overdueRows) {
        console.log(`    ${row.id} — ${row.amount} — ${row.seller}`);
      }
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
