// Brief 8 — Listing Controller test infrastructure.
//
// Shared Prisma mock. Each test file should jest.mock the prisma module and
// route every method to `mockPrisma` so tests can drive return values and
// assert on arguments. This file declares every Prisma method the
// ListingController touches — if a new method is used in the controller,
// add it here too.

import { jest } from '@jest/globals';

// Every method is jest.fn<() => Promise<any>>() so that .mockResolvedValue(...)
// accepts any shape of resolved data. The whole object is also exposed as
// `any` to avoid infecting test files with deep Prisma types — tests care
// about call arguments, not the Prisma type graph.
const fn = () => jest.fn<(...args: any[]) => any>();

export const mockPrisma: any = {
  users: {
    findUnique: fn(),
  },
  listings: {
    findMany: fn(),
    findUnique: fn(),
    create: fn(),
    update: fn(),
    updateMany: fn(),
    delete: fn(),
    count: fn(),
  },
  listing_attributes: {
    findMany: fn(),
    createMany: fn(),
    deleteMany: fn(),
  },
  images: {
    findUnique: fn(),
    delete: fn(),
  },
  favorites: {
    count: fn(),
  },
  orders: {
    findFirst: fn(),
  },
  $executeRaw: fn(),
};

/**
 * Reset every mock function on the prisma surface. Call from beforeEach
 * to keep tests independent.
 */
export function resetMockPrisma(): void {
  const visit = (node: any) => {
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (typeof val === 'function' && typeof val.mockReset === 'function') {
        val.mockReset();
      } else if (val && typeof val === 'object') {
        visit(val);
      }
    }
  };
  visit(mockPrisma);
}
