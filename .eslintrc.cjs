/* eslint-env node */
/**
 * Root ESLint config for the Data-Pulse-2 monorepo.
 * Workspace packages may extend or override this file via their own .eslintrc.
 *
 * `pnpm lint:eslint` runs this file. The tenant-scope rule lives in
 * tools/eslint-rules and is loaded by eslint-plugin-rulesdir (no published
 * local plugin). Issue #618 G1 approved wiring it here.
 */
const path = require("path");
const rulesDirPlugin = require("eslint-plugin-rulesdir");

rulesDirPlugin.RULES_DIR = path.join(__dirname, "tools", "eslint-rules");

module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: false
  },
  plugins: ["@typescript-eslint", "rulesdir"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  env: {
    node: true,
    es2022: true
  },
  rules: {
    "rulesdir/no-unscoped-tenant-query": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
    ],
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "eqeqeq": ["error", "always"],
    "no-implicit-coercion": "error"
  },
  ignorePatterns: [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "**/*.d.ts",
    ".turbo",
    ".cache"
  ]
};
