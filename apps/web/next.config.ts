import type { NextConfig } from 'next';

/**
 * The portal reads the shop straight from Postgres with the owner's own
 * sign-in, so there is no server-side secret and nothing to keep warm. Row
 * level security is the boundary, exactly as it is for the counter.
 *
 * `transpilePackages` because @pos/shared ships as TypeScript sources compiled
 * for Node; Next needs to put it through its own pipeline for the browser.
 */
const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@pos/shared'],
  typedRoutes: true,
};

export default config;
