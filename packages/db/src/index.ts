/**
 * Database access for DrishtiNet.
 *
 * A single PrismaClient is shared process-wide (and cached across Next.js hot reloads) because
 * each instance holds its own connection pool; creating them per-request exhausts Postgres.
 */
import { PrismaClient } from '@prisma/client';

export * from './spatial.js';
export { PrismaClient } from '@prisma/client';
export type * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
