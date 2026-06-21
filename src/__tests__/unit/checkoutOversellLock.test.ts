/**
 * SB-03b: Verify that checkout decrement paths acquire FOR UPDATE row locks
 * for size-variant listings, matching the pattern in restoreListingStock.
 *
 * These tests verify the lock pattern by reading the source code of each
 * checkout controller and asserting the FOR UPDATE + re-read sequence is
 * present. A true concurrent-buyer integration test would need a running
 * database; this locks in the structural guarantee.
 */
import * as fs from 'fs';
import * as path from 'path';

const controllersDir = path.resolve(__dirname, '../../controllers');

const CHECKOUT_FILES = [
  { file: 'cartCheckoutController.ts', label: 'cart checkout' },
  { file: 'nativePaymentController.ts', label: 'native payment' },
  { file: 'stripeController.ts', label: 'single-item checkout' },
];

describe('SB-03b: checkout size-variant decrement uses FOR UPDATE row lock', () => {
  const sources: Record<string, string> = {};

  beforeAll(() => {
    for (const { file } of CHECKOUT_FILES) {
      sources[file] = fs.readFileSync(path.join(controllersDir, file), 'utf-8');
    }
  });

  test.each(CHECKOUT_FILES)(
    '$label ($file) contains SELECT ... FOR UPDATE before stock read',
    ({ file }) => {
      const src = sources[file];
      expect(src).toContain('FOR UPDATE');
      expect(src).toContain('$queryRawUnsafe');
    },
  );

  test.each(CHECKOUT_FILES)(
    '$label ($file) reads listing AFTER acquiring the lock (findUnique follows FOR UPDATE)',
    ({ file }) => {
      const src = sources[file];
      const forUpdateIdx = src.indexOf('FOR UPDATE');
      const findUniqueAfterLock = src.indexOf('findUnique', forUpdateIdx);
      expect(forUpdateIdx).toBeGreaterThan(-1);
      expect(findUniqueAfterLock).toBeGreaterThan(forUpdateIdx);
    },
  );

  test.each(CHECKOUT_FILES)(
    '$label ($file) size-variant decrement is inside a $transaction',
    ({ file }) => {
      const src = sources[file];
      expect(src).toContain('$transaction');
      const txIdx = src.indexOf('$transaction');
      const forUpdateIdx = src.indexOf('FOR UPDATE');
      expect(forUpdateIdx).toBeGreaterThan(txIdx);
    },
  );

  test.each(CHECKOUT_FILES)(
    '$label ($file) still has atomic updateMany for non-size-variant path',
    ({ file }) => {
      const src = sources[file];
      expect(src).toContain('updateMany');
      expect(src).toContain('decrement: orderQuantity');
    },
  );

  test.each(CHECKOUT_FILES)(
    '$label ($file) has insufficient-stock error for size-variant under-lock case',
    ({ file }) => {
      const src = sources[file];
      expect(src).toMatch(/Insufficient stock/);
    },
  );
});
