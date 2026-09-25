"use strict";

/**
 * T208 smoke test for tools/eslint-rules/no-unscoped-tenant-query.js.
 * Plain CJS so `node --test` runs it on Node 20. There is no Jest project
 * rooted at tools/.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { ESLint, Linter } = require("eslint");

const rule = require("../no-unscoped-tenant-query");

const POOL_FIXTURE = "drizzle(pool).select().from(stores);\n";
const CLIENT_FIXTURE = "drizzle(client).select().from(stores);\n";

function lintWithRule(code) {
  const linter = new Linter();
  linter.defineRule("no-unscoped-tenant-query", rule);
  return linter.verify(code, {
    parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: { "no-unscoped-tenant-query": "error" },
  });
}

test("drizzle(pool).select().from(stores) is an error", () => {
  const messages = lintWithRule(POOL_FIXTURE);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "no-unscoped-tenant-query");
  assert.equal(messages[0].messageId, "unscopedQuery");
});

test("drizzle(client).select().from(stores) is clean", () => {
  const messages = lintWithRule(CLIENT_FIXTURE);
  assert.deepEqual(messages, []);
});

test("root eslintrc reports the pool fixture and accepts the client fixture", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const eslint = new ESLint({ cwd: repoRoot, useEslintrc: true });
  const filePath = path.join(
    repoRoot,
    "apps",
    "api",
    "src",
    "__tenant_rule_fixture__.ts",
  );
  const [pooled] = await eslint.lintText(POOL_FIXTURE, { filePath });
  const [client] = await eslint.lintText(CLIENT_FIXTURE, { filePath });
  const ruleId = "rulesdir/no-unscoped-tenant-query";
  const pooledHits = pooled.messages.filter((message) => message.ruleId === ruleId);
  const clientHits = client.messages.filter((message) => message.ruleId === ruleId);
  assert.equal(pooledHits.length, 1);
  assert.equal(clientHits.length, 0);
});
