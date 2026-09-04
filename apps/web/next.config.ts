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
  /**
   * Normally `.next`; overridden only by the E2E suite.
   *
   * `NEXT_PUBLIC_API_BASE_URL` is inlined into the browser bundle at BUILD time, so
   * an E2E run that points the app at its fake API has to build its own copy —
   * restarting with a different value changes nothing. Without a separate directory
   * that build would overwrite the one a developer is running, and the overwrite is
   * invisible until a page starts calling a port that is not there.
   */
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
};

export default nextConfig;
