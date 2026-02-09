// src/lib/prisma.ts
// Shared PrismaClient singleton — import this instead of creating new instances
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #19] NEW FILE: Centralizes PrismaClient to prevent connection pool exhaustion.
//             Every controller/job file should `import { prisma } from '../lib/prisma'`
//             instead of `const prisma = new PrismaClient()`.

import { PrismaClient } from '@prisma/client';

// Use global to prevent multiple instances during hot-reload in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
