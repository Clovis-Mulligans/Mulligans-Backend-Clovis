/**
 * Admin Stats Status Filter Tests
 *
 * Verifies that each money metric in adminStatsController uses the correct
 * order-status filter set — no phantom statuses ('shipped', 'paid'), and
 * per-metric distinctions (GMV vs realised vs pending escrow).
 *
 * Uses a seeded set of orders spanning ALL eight real statuses.
 *
 * Run: npx jest --selectProjects unit adminStatsStatusFilter
 */

import {
  GMV_STATUSES,
  REALISED_STATUSES,
  PENDING_ESCROW_STATUSES,
} from '../../controllers/adminStatsController';

// Fee constants exist on main in feeCalculations.ts
const BUYER_PROTECTION_RATE = 0.075;
const SERVICE_FEE_PER_ITEM = 0.99;

// ─── All eight real prod statuses ──────────────────────────────────────
const ALL_REAL_STATUSES = [
  'cancelled',
  'completed',
  'delivered',
  'disputed',
  'in_transit',
  'refunded',
  'returned',
  'to_ship',
] as const;

// Seed data: one order per status, with known amounts
const SEED_ORDERS = [
  { status: 'cancelled',  amount: 10 },
  { status: 'completed',  amount: 20 },
  { status: 'delivered',  amount: 30 },
  { status: 'disputed',   amount: 40 },
  { status: 'in_transit',  amount: 50 },
  { status: 'refunded',   amount: 60 },
  { status: 'returned',   amount: 70 },
  { status: 'to_ship',    amount: 80 },
] as const;

// ─── Status-set correctness ───────────────────────────────────────────

describe('exported status constants — correctness', () => {
  test('GMV_STATUSES includes completed, delivered, in_transit, to_ship, disputed', () => {
    expect([...GMV_STATUSES].sort()).toEqual(
      ['completed', 'delivered', 'disputed', 'in_transit', 'to_ship']
    );
  });

  test('GMV_STATUSES excludes cancelled, refunded, returned', () => {
    const gmvSet = new Set(GMV_STATUSES);
    expect(gmvSet.has('cancelled' as any)).toBe(false);
    expect(gmvSet.has('refunded' as any)).toBe(false);
    expect(gmvSet.has('returned' as any)).toBe(false);
  });

  test('REALISED_STATUSES is completed only', () => {
    expect([...REALISED_STATUSES]).toEqual(['completed']);
  });

  test('PENDING_ESCROW_STATUSES includes to_ship, in_transit, delivered', () => {
    expect([...PENDING_ESCROW_STATUSES].sort()).toEqual(
      ['delivered', 'in_transit', 'to_ship']
    );
  });

  test('PENDING_ESCROW_STATUSES excludes completed (already released)', () => {
    const escrowSet = new Set(PENDING_ESCROW_STATUSES);
    expect(escrowSet.has('completed' as any)).toBe(false);
  });
});

// ─── Phantom-status regression guard ──────────────────────────────────

describe('phantom status regression — shipped/paid must never appear', () => {
  test('GMV_STATUSES does not contain shipped or paid', () => {
    const gmvSet = new Set(GMV_STATUSES);
    expect(gmvSet.has('shipped' as any)).toBe(false);
    expect(gmvSet.has('paid' as any)).toBe(false);
  });

  test('REALISED_STATUSES does not contain shipped or paid', () => {
    const set = new Set(REALISED_STATUSES);
    expect(set.has('shipped' as any)).toBe(false);
    expect(set.has('paid' as any)).toBe(false);
  });

  test('PENDING_ESCROW_STATUSES does not contain shipped or paid', () => {
    const set = new Set(PENDING_ESCROW_STATUSES);
    expect(set.has('shipped' as any)).toBe(false);
    expect(set.has('paid' as any)).toBe(false);
  });

  test('no status constant references any non-existent status', () => {
    const allConstants = [
      ...GMV_STATUSES,
      ...REALISED_STATUSES,
      ...PENDING_ESCROW_STATUSES,
    ];
    const realSet = new Set(ALL_REAL_STATUSES);
    for (const s of allConstants) {
      expect(realSet.has(s as any)).toBe(true);
    }
  });
});

// ─── Per-metric aggregation logic ─────────────────────────────────────

function sumForStatuses(statuses: readonly string[]): number {
  const statusSet = new Set(statuses);
  return SEED_ORDERS
    .filter(o => statusSet.has(o.status))
    .reduce((acc, o) => acc + o.amount, 0);
}

function countForStatuses(statuses: readonly string[]): number {
  const statusSet = new Set(statuses);
  return SEED_ORDERS.filter(o => statusSet.has(o.status)).length;
}

describe('GMV aggregation — seeded order set', () => {
  const expectedGMV = sumForStatuses(GMV_STATUSES);
  const expectedCount = countForStatuses(GMV_STATUSES);

  test('GMV includes completed(20) + delivered(30) + in_transit(50) + to_ship(80) + disputed(40) = 220', () => {
    expect(expectedGMV).toBe(220);
  });

  test('GMV count is 5 orders', () => {
    expect(expectedCount).toBe(5);
  });

  test('GMV excludes cancelled(10) + refunded(60) + returned(70)', () => {
    const excludedSum = sumForStatuses(['cancelled', 'refunded', 'returned']);
    expect(excludedSum).toBe(140);
    expect(expectedGMV + excludedSum).toBe(
      SEED_ORDERS.reduce((s, o) => s + o.amount, 0)
    );
  });
});

describe('pending escrow aggregation — seeded order set', () => {
  const expectedEscrow = sumForStatuses(PENDING_ESCROW_STATUSES);

  test('pending escrow includes to_ship(80) + in_transit(50) + delivered(30) = 160', () => {
    expect(expectedEscrow).toBe(160);
  });

  test('pending escrow is non-zero (guards £0 regression)', () => {
    expect(expectedEscrow).toBeGreaterThan(0);
  });

  test('pending escrow excludes completed (already released)', () => {
    const escrowSet = new Set(PENDING_ESCROW_STATUSES);
    expect(escrowSet.has('completed' as any)).toBe(false);
  });
});

describe('realised revenue aggregation — seeded order set', () => {
  const expectedRealised = sumForStatuses(REALISED_STATUSES);

  test('realised revenue = completed only = 20', () => {
    expect(expectedRealised).toBe(20);
  });

  test('realised revenue < GMV (not all sold orders are settled)', () => {
    expect(expectedRealised).toBeLessThan(sumForStatuses(GMV_STATUSES));
  });
});

describe('fee calculations — gross vs realised', () => {
  const gmvTotal = sumForStatuses(GMV_STATUSES);
  const gmvCount = countForStatuses(GMV_STATUSES);
  const realisedTotal = sumForStatuses(REALISED_STATUSES);
  const realisedCount = countForStatuses(REALISED_STATUSES);

  const grossFees = (gmvTotal * BUYER_PROTECTION_RATE) + (gmvCount * SERVICE_FEE_PER_ITEM);
  const realisedFees = (realisedTotal * BUYER_PROTECTION_RATE) + (realisedCount * SERVICE_FEE_PER_ITEM);

  test('gross fees = 220 * 0.075 + 5 * 0.99 = 16.50 + 4.95 = 21.45', () => {
    expect(grossFees).toBeCloseTo(21.45, 2);
  });

  test('realised fees = 20 * 0.075 + 1 * 0.99 = 1.50 + 0.99 = 2.49', () => {
    expect(realisedFees).toBeCloseTo(2.49, 2);
  });

  test('gross fees > realised fees', () => {
    expect(grossFees).toBeGreaterThan(realisedFees);
  });
});

// ─── Source-code grep: phantom statuses must not appear in queries ─────

import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('source-code regression — no phantom statuses in money queries', () => {
  const controllerPath = resolve(
    __dirname,
    '../../controllers/adminStatsController.ts'
  );
  const source = readFileSync(controllerPath, 'utf8');

  // Strip the comment block that documents the phantom statuses
  const codeOnly = source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');

  test("'shipped' does not appear in non-comment code", () => {
    expect(codeOnly).not.toContain("'shipped'");
  });

  test("'paid' does not appear in non-comment code", () => {
    expect(codeOnly).not.toContain("'paid'");
  });
});
