import path from 'node:path';
import type { NextConfig } from 'next';

/** The pnpm workspace root — `next` itself lives in the root virtual store. */
const workspaceRoot = path.resolve(__dirname, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Typed, checked builds. `ignoreBuildErrors` must stay false: apps/web is the one
  // place the TS 7.0.2 branch of the dual-TypeScript policy is exercised end to end,
  // and silencing it would make that half of the policy unverifiable.
  typescript: { ignoreBuildErrors: false },
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
