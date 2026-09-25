/**
 * ESLint rule: no-unscoped-tenant-query
 *
 * Flags Drizzle query chains of the form:
 *
 *   drizzle(pool).select().from(<tenantScopedTable>)
 *   drizzle(this.pool).insert().into(<tenantScopedTable>)
 *   // … and any .select/.insert/.update/.delete chain whose .from() or
 *   //   .into() argument is a known tenant-scoped table reference.
 *
 * where the first argument to drizzle() resolves to a plain Pool by name
 * (matches /\bpool\b/i or this.pool). If the argument is "client" or
 * "this.client" — conventionally a PoolClient from runWithTenantContext —
 * the call is allowed.
 *
 * File-level opt-out
 * ------------------
 * A file-level comment of the form:
 *
 *   /* no-rls-scope: <reason> *\/
 *
 * suppresses the rule for the entire file. This is the companion to the
 * hard-coded ALLOWLIST in apps/api/test/authz/no-unscoped-tenant-query.spec.ts.
 * Note: the Jest CI guard does NOT honour this comment — the ALLOWLIST is
 * the only load-bearing opt-out for that guard.
 *
 * Wired in the root .eslintrc.cjs via eslint-plugin-rulesdir as
 * `rulesdir/no-unscoped-tenant-query` (issue #618 G1). CI runs it with
 * `pnpm lint:eslint`.
 */

"use strict";

// ---------------------------------------------------------------------------
// Tenant-scoped table names (snake_case and camelCase Drizzle aliases).
// Kept in sync with apps/api/test/authz/no-unscoped-tenant-query.spec.ts.
// ---------------------------------------------------------------------------
const TENANT_SCOPED_TABLES = new Set([
  "tenants",
  "stores",
  "memberships",
  "storeAccess",
  "store_access",
  "roles",
  "authTokens",
  "auth_tokens",
  "invitations",
  "auditEvents",
  "audit_events",
  "idempotencyKeys",
  "idempotency_keys",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an ESLint AST node looks like a Pool argument (not a
 * PoolClient). We accept: `pool`, `this.pool`, `adminPool`, `this.adminPool`,
 * or any identifier ending in "Pool" (case-insensitive). We explicitly
 * exclude identifiers that look like PoolClient references ("client",
 * "this.client", any identifier ending in "Client").
 */
function looksLikePool(node) {
  if (!node) return false;
  let name = "";
  if (node.type === "Identifier") {
    name = node.name;
  } else if (
    node.type === "MemberExpression" &&
    node.property.type === "Identifier"
  ) {
    name = node.property.name;
  }
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith("client")) return false; // PoolClient — safe
  if (lower === "pool" || lower.endsWith("pool")) return true;
  return false;
}

/**
 * Return the identifier name if the node is a plain Identifier or a
 * MemberExpression of the form <anything>.<ident>; undefined otherwise.
 */
function leafName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (
    node.type === "MemberExpression" &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return undefined;
}

/**
 * Walk up a MemberExpression / CallExpression chain and collect the
 * identifiers / call names in left-to-right order.
 * Returns true if the chain contains a drizzle(pool) at the root AND
 * a .from(<tenantTable>) or .into(<tenantTable>) call anywhere in the chain.
 */
function analyseChain(node) {
  // We look for: CallExpression whose callee is a MemberExpression ending in
  // .from or .into, where the argument is a tenant-scoped table reference.
  // We then walk up the chain to find if drizzle(<pool>) is at the root.

  if (node.type !== "CallExpression") return { isDrizzlePool: false, tenantTable: null };

  const callee = node.callee;

  // Is this call drizzle(<arg>)?
  if (
    callee.type === "Identifier" &&
    callee.name === "drizzle" &&
    node.arguments.length > 0 &&
    looksLikePool(node.arguments[0])
  ) {
    return { isDrizzlePool: true, tenantTable: null };
  }

  // Is this call .from(<arg>) or .into(<arg>)?
  if (
    callee.type === "MemberExpression" &&
    (callee.property.name === "from" || callee.property.name === "into") &&
    node.arguments.length > 0
  ) {
    const tableArg = node.arguments[0];
    const tableName = leafName(tableArg);
    if (tableName && TENANT_SCOPED_TABLES.has(tableName)) {
      return { isDrizzlePool: false, tenantTable: tableName };
    }
  }

  return { isDrizzlePool: false, tenantTable: null };
}

// ---------------------------------------------------------------------------
// Rule definition
// ---------------------------------------------------------------------------

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid un-tenant-scoped Drizzle queries against tenant-scoped tables",
      recommended: false,
    },
    messages: {
      unscopedQuery:
        "Un-tenant-scoped Drizzle query against tenant-scoped table '{{table}}'. " +
        "Use a PoolClient from runWithTenantContext, or add a file-level " +
        "/* no-rls-scope: <reason> */ comment if this is a deliberate exception.",
    },
    schema: [],
  },

  create(context) {
    // -----------------------------------------------------------------------
    // File-level opt-out: /* no-rls-scope: <reason> */
    // -----------------------------------------------------------------------
    let fileOptOut = false;

    const sourceCode = context.getSourceCode();
    const allComments = sourceCode.getAllComments();
    for (const comment of allComments) {
      if (/^\s*no-rls-scope\s*:/i.test(comment.value)) {
        fileOptOut = true;
        break;
      }
    }

    if (fileOptOut) {
      // Return an empty visitor — no checks for this file.
      return {};
    }

    // -----------------------------------------------------------------------
    // We walk CallExpression nodes. When we see:
    //
    //   drizzle(pool)
    //     .select() / .insert() / .update() / .delete()
    //     ...
    //     .from(tenantTable) / .into(tenantTable)
    //
    // we flag it.
    //
    // Strategy: on .from/.into, walk to the root call and test it directly.
    // ESLint visits the outer CallExpression first, so a set filled by a
    // nested drizzle() visit would still be empty when .from() is checked.
    // -----------------------------------------------------------------------

    function rootCallExpression(node) {
      // Walk callee chain to find the root CallExpression.
      let n = node;
      while (n && n.type === "CallExpression" && n.callee.type === "MemberExpression") {
        n = n.callee.object;
      }
      return n;
    }

    function isDrizzlePoolCall(node) {
      return (
        node &&
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "drizzle" &&
        node.arguments.length > 0 &&
        looksLikePool(node.arguments[0])
      );
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // Detect .from(<tenantTable>) or .into(<tenantTable>) calls.
        // Inspect the root here. ESLint visits the outer call first, so a
        // side set filled by an earlier drizzle() visit would always be empty.
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          (callee.property.name !== "from" && callee.property.name !== "into") ||
          node.arguments.length === 0
        ) {
          return;
        }

        const tableName = leafName(node.arguments[0]);
        if (!tableName || !TENANT_SCOPED_TABLES.has(tableName)) return;

        if (isDrizzlePoolCall(rootCallExpression(callee.object))) {
          context.report({
            node,
            messageId: "unscopedQuery",
            data: { table: tableName },
          });
        }
      },
    };
  },
};
