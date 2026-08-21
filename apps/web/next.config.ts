import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { NextConfig } from 'next';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

/**
 * Load the repository-root `.env`.
 *
 * Next only auto-loads `.env` from the app directory, but this is a monorepo with ONE `.env` at the
 * root — shared by the gateway, Prisma, docker-compose and the Makefile. Without this, `next dev`
 * starts with no DATABASE_URL and every registry query fails at request time, while `make web-dev`
 * works because it sources the file first. Making the app load its own configuration removes that
 * difference: every entry point behaves the same.
 *
 * `loadEnvFile` does not overwrite variables that are already set, so an explicit environment still
 * wins — which is what containers rely on. In Docker there is no root `.env` to find and the values
 * arrive through env_file, hence the tolerated miss rather than a hard failure.
 */
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // Absent or unreadable. Expected inside the container; elsewhere the missing variable surfaces
  // at first use with a clearer message than anything we could raise here.
}

const nextConfig: NextConfig = {
  // Self-hosted, offline, one container. Never Vercel.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,

  // Next infers the workspace root from the nearest lockfile and had picked up an unrelated
  // package-lock.json in $HOME. Pin it, or `output: standalone` traces the wrong tree.
  outputFileTracingRoot: REPO_ROOT,

  // The workspace packages ship TypeScript source, not built artifacts.
  transpilePackages: ['@drishtinet/shared', '@drishtinet/db', '@drishtinet/stream-gateway'],

  // Prisma must not be bundled into the server runtime.
  serverExternalPackages: ['@prisma/client', '.prisma/client'],

  eslint: { ignoreDuringBuilds: true },

  webpack: (config) => {
    // Our TypeScript sources use ESM-correct `./foo.js` specifiers that actually resolve to
    // `./foo.ts`. tsc and tsx understand that; webpack needs to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
