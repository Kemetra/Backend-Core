/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/test/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Explicitly point ts-jest at our tsconfig so `module: NodeNext`
  // (which honours `package.json#exports` subpaths) is used for both
  // type-check and emit. Without this, ts-jest synthesises a CJS-style
  // tsconfig that doesn't see workspace subpath exports.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        // isolatedModules makes ts-jest use the simpler transpiler instead
        // of the LanguageService — the LanguageService does NOT fully honour
        // `package.json#exports` for workspace subpath imports under
        // `module: NodeNext`, while the transpiler does.
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
      statements: 96,
      // #618 G2 — the 90 branch gate made CI drop --coverage entirely. The
      // first CI run with coverage back on measured 85.15% branches and
      // 96.83% lines, so the enforced floors are 85 and 96. Ratchet them up
      // as the suite improves; never lower them to pass a PR.
      branches: 85,
      functions: 95,
      lines: 96,
    },
  },
};
