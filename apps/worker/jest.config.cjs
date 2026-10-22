/**
 * Worker test config.
 *
 * Test segmentation (CI):
 *   - `fast` job (no Docker): default — Testcontainers-backed outbox suites
 *     are excluded via `testPathIgnorePatterns`. Set in jest config rather
 *     than via CLI to avoid shell-escaping issues with regex backslashes
 *     across Linux/Windows/pnpm boundaries.
 *   - `db-integration` job (Docker available): set
 *     `WORKER_INCLUDE_DB_TESTS=1` in the environment to clear the exclusion
 *     so the integration outbox suites run.
 *
 * Locally:
 *   - Default behaviour matches the `fast` job (no Docker required).
 *   - To exercise the Testcontainers suites locally, run with
 *     `WORKER_INCLUDE_DB_TESTS=1`.
 */
const includeDbBackedTests =
  process.env.WORKER_INCLUDE_DB_TESTS === "1";

const dockerOutboxSuites = includeDbBackedTests
  ? []
  : ["/outbox/retry-budget\\.spec\\.ts$",
     "/outbox/idempotent-consumer\\.spec\\.ts$",
     "/outbox/tenant-context\\.spec\\.ts$",
     // 008-WORKER Testcontainers suites — Docker-free fast job excludes them,
     // db-integration job clears the exclusion via WORKER_INCLUDE_DB_TESTS=1.
     "/sales/processing\\.spec\\.ts$",
     "/sales/idempotent-processing\\.spec\\.ts$",
     // DP-008-LIVELOOP Slice 2 end-to-end (capture → drain → consume → process).
     "/sales/dp-008-liveloop\\.e2e\\.spec\\.ts$",
     // 015-US1-FEED posting-requested consumer (resolve eligibility + insert).
     "/erpnext-posting/posting-requested-consumer\\.spec\\.ts$",
     // 017-US3 reconciliation-run processor (009 on-hand vs ERPNext-Bin compare).
     "/erpnext-reconciliation/reconciliation-run\\.spec\\.ts$",
     // RT-428 pending-aware 017 run (activated vs legacy tenant).
     "/erpnext-reconciliation/pending-aware-run\\.spec\\.ts$",
     // RT-457 sale re-drive sweep against real Postgres.
     "/sales/sale-redrive\\.integration\\.spec\\.ts$",
     // RT-427 sale effects written with the intent and linked by the consumer.
     "/sales/sale-effects\\.integration\\.spec\\.ts$"];

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/test/**/*.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", ...dockerOutboxSuites],
  moduleFileExtensions: ["ts", "js", "json"],
  // Mirrors apps/api/jest.config.cjs — see that file for why ts-jest is
  // pinned to this exact tsconfig with `isolatedModules: true`.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        isolatedModules: true,
      },
    ],
  },
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 30000,
  verbose: false,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/**/*.d.ts",
    "!src/main.ts",
  ],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
  },
};
