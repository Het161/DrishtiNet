import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { NextConfig } from 'next';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

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
