import { defineConfig } from 'vitest/config';

/**
 * TD-1 — Vitest, not Jest. `ts-jest` transforms by calling into the TypeScript
 * compiler API, which TS 7.0 removed (it returns in 7.1); Vitest transforms with
 * esbuild via Vite and never touches that API, so it works under the dual-compiler
 * policy without a third transform pipeline.
 *
 * One project per boundary, because the boundaries have different rights:
 *  - `domain` gets NO setup file and no environment beyond `node`. That is the
 *    executable form of AD-1 — if a domain test ever needs a database or a socket,
 *    the dependency direction has already been broken upstream.
 *  - `db` may use Docker (Testcontainers) and is given the long timeouts that
 *    implies.
 *  - `gates` shells out to the real compiler and the real dependency-cruiser to
 *    prove CI gate #2 turns red (TD-4).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          root: './packages/domain',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Intentionally empty and intentionally commented: adding a setup file
          // here is how "the domain needs no infrastructure" quietly stops being true.
          setupFiles: [],
        },
      },
      {
        test: {
          name: 'contracts',
          root: './packages/contracts',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          setupFiles: [],
        },
      },
      {
        test: {
          name: 'config',
          root: './packages/config',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          setupFiles: [],
        },
      },
      {
        test: {
          name: 'db',
          root: './packages/db',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Pulling and booting a Postgres 18 image is slow the first time.
          testTimeout: 180_000,
          hookTimeout: 300_000,
          // Each file in this project boots its OWN Postgres 18 container. Run in
          // parallel that is two containers, two image pulls on a cold runner and
          // two sets of port bindings competing for the same CI box — the usual
          // shape of a flaky, occasionally-OOM gate. Sequential is slower and
          // survives a small runner, which is the trade a required check wants.
          fileParallelism: false,
        },
      },
      {
        test: {
          // TD-1 puts both processes under Vitest too. Today it carries the
          // logging policy tests: AD-15 redaction had no test anywhere, so
          // deleting `req.headers.cookie` from the list left every gate green.
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          setupFiles: [],
        },
      },
      {
        test: {
          name: 'gates',
          root: './tests/gates',
          environment: 'node',
          include: ['**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          // Each example writes, then deletes, a file inside packages/domain/src.
          // They must not run at the same time as one another.
          fileParallelism: false,
        },
      },
    ],
  },
});
