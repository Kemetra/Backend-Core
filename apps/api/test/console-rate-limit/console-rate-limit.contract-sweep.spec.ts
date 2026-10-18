/**
 * RT-620 — console 429 contract sweep (RT-574 issue 2, D5/D7).
 *
 * Every cookieAuth operation in every contract documents the console 429
 * (`TooManyRequests`: required `Retry-After` 1..3600, `Cache-Control:
 * no-store` and `X-Request-Id`, and the file's canonical `Error` body),
 * EXCEPT the operations on the shared exemption list, which must not. The list
 * is imported from the runtime, the same one the guard and the RT-619 ratchet
 * use, so this sweep can never force a false 429 into an exempt contract, and
 * a new cookieAuth operation without a 429 fails here. No budget number may
 * appear in the documented 429.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { load as parseYaml } from "js-yaml";

import { CONSOLE_RATE_LIMIT_BUDGETS } from "../../src/console-rate-limit/console-rate-limit.config";
import { CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS } from "../../src/console-rate-limit/console-rate-limit.exemptions";
import { CONTRACTS_DIR, yamlFiles } from "../_helpers/openapi-routes";

type Node = Record<string, unknown>;

interface CookieOp {
  readonly file: string;
  /** The operationId, or `METHOD path` when the operation has none. */
  readonly id: string;
  readonly document: Node;
  readonly responses: Node;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const EXEMPT: ReadonlySet<string> = new Set(CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS);

function asNode(value: unknown): Node {
  return (value ?? {}) as Node;
}

/** Follows one same-file `$ref` (`#/a/b/c`); returns the node itself otherwise. */
function deref(document: Node, node: unknown): Node {
  const ref = asNode(node)["$ref"];
  if (typeof ref !== "string") return asNode(node);
  expect(ref.startsWith("#/")).toBe(true);
  return ref
    .slice(2)
    .split("/")
    .reduce<Node>((acc, key) => asNode(acc[key]), document);
}

function opsOf(file: string, document: Node): CookieOp[] {
  const defaultSecurity = document["security"];
  return Object.entries(asNode(document["paths"])).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const op = asNode(item)[method];
      if (op === undefined) return [];
      const { operationId, security, responses } = asNode(op);
      const cookie = ((security ?? defaultSecurity ?? []) as Node[]).some((r) => "cookieAuth" in r);
      const id = typeof operationId === "string" ? operationId : `${method.toUpperCase()} ${path}`;
      return cookie ? [{ file, id, document, responses: asNode(responses) }] : [];
    }),
  );
}

function cookieOps(): CookieOp[] {
  return yamlFiles(CONTRACTS_DIR).flatMap((path) =>
    opsOf(relative(CONTRACTS_DIR, path), parseYaml(readFileSync(path, "utf8")) as Node),
  );
}

/** A response header as a client sees it: whether it is required, and its schema. */
function header(document: Node, headers: Node, name: string) {
  const h = deref(document, headers[name]);
  return { required: h["required"], schema: h["schema"] };
}

/** The documented 429 of `op`, flattened to what a client sees. */
function console429(op: CookieOp) {
  const response = deref(op.document, op.responses["429"]);
  const headers = asNode(response["headers"]);
  const body = deref(op.document, asNode(asNode(response["content"])["application/json"])["schema"]);
  const error = asNode(asNode(body["properties"])["error"]);
  return {
    shape: {
      retryAfter: header(op.document, headers, "Retry-After"),
      cacheControl: header(op.document, headers, "Cache-Control"),
      requestId: header(op.document, headers, "X-Request-Id"),
      envelopeRequired: body["required"],
      errorRequired: error["required"],
      errorFields: Object.keys(asNode(error["properties"])),
    },
    description: `${String(response["description"])} ${String(deref(op.document, headers["Retry-After"])["description"])}`,
  };
}

describe("console 429 contract sweep (RT-620 / RT-574 D7)", () => {
  const ops = cookieOps();
  const limited = ops.filter((op) => !EXEMPT.has(op.id));
  const label = (op: CookieOp) => `${op.file}: ${op.id}`;

  it("the sweep is not vacuous: every exempt operation is a cookieAuth operation, and 103+ are limited", () => {
    expect(ops.map((op) => op.id)).toEqual(expect.arrayContaining([...EXEMPT]));
    expect(limited.length).toBeGreaterThanOrEqual(103);
  });

  it("no exempt operation documents a 429", () => {
    expect(ops.filter((op) => EXEMPT.has(op.id) && "429" in op.responses).map(label)).toEqual([]);
  });

  it("every other cookieAuth operation documents the console 429", () => {
    expect(limited.filter((op) => !("429" in op.responses)).map(label)).toEqual([]);
  });

  it("each 429 requires the bounded Retry-After, no-store and X-Request-Id, with the canonical error envelope", () => {
    const expected = {
      retryAfter: { required: true, schema: { type: "integer", minimum: 1, maximum: 3600 } },
      cacheControl: { required: true, schema: { type: "string", enum: ["no-store"] } },
      requestId: { required: true, schema: { type: "string", format: "uuid" } },
      envelopeRequired: ["error"],
      // Some files also require `request_id`.
      errorRequired: expect.arrayContaining(["code", "message"]),
      // Some files' envelope also carries an optional `details`.
      errorFields: expect.arrayContaining(["code", "message", "request_id"]),
    };
    for (const op of limited) {
      expect({ op: label(op), ...console429(op).shape }).toEqual({ op: label(op), ...expected });
    }
  });

  it("each 429 names the `rate_limited` code and leaks no budget number", () => {
    const limits = Object.values(CONSOLE_RATE_LIMIT_BUDGETS).map((b) => String(b.limit));
    const problems = limited.flatMap((op) => {
      const { description } = console429(op);
      const numbers = description.split(/\D+/);
      return [
        ...(description.includes("`rate_limited`") ? [] : [`${label(op)}: no rate_limited`]),
        ...limits.filter((limit) => numbers.includes(limit)).map((limit) => `${label(op)}: ${limit}`),
      ];
    });
    expect(problems).toEqual([]);
  });
});
