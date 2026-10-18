/**
 * RT-620 — console 429 contract sweep (RT-574 issue 2, D5/D7).
 *
 * Every cookieAuth operation in every contract documents the console 429
 * (`TooManyRequests`: a bounded `Retry-After`, `Cache-Control: no-store` and
 * the file's canonical `Error` body), EXCEPT the operations on the shared
 * exemption list, which must not. The list is imported from the runtime, the
 * same one the guard and the RT-619 ratchet use, so this sweep can never force
 * a false 429 into an exempt contract, and a new cookieAuth operation without
 * a 429 fails here. No budget number may appear in the documented 429.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { CONSOLE_RATE_LIMIT_BUDGETS } from '../../src/console-rate-limit/console-rate-limit.config';
import { CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS } from '../../src/console-rate-limit/console-rate-limit.exemptions';
import { CONTRACTS_DIR, yamlFiles } from '../_helpers/openapi-routes';

type Node = Record<string, unknown>;

interface CookieOp {
  readonly file: string;
  readonly operationId: string;
  readonly document: Node;
  readonly responses: Node;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const EXEMPT: ReadonlySet<string> = new Set(CONSOLE_RATE_LIMIT_EXEMPT_OPERATION_IDS);

function asNode(value: unknown): Node {
  return (value ?? {}) as Node;
}

/** Follows one same-file `$ref` (`#/a/b/c`); returns the node itself otherwise. */
function deref(document: Node, node: unknown): Node {
  const ref = asNode(node)['$ref'];
  if (typeof ref !== 'string') return asNode(node);
  expect(ref.startsWith('#/')).toBe(true);
  return ref
    .slice(2)
    .split('/')
    .reduce<Node>((acc, key) => asNode(acc[key]), document);
}

function opsOf(file: string, document: Node): CookieOp[] {
  const defaultSecurity = document['security'];
  return Object.values(asNode(document['paths'])).flatMap((item) =>
    METHODS.map((method) => asNode(asNode(item)[method])).flatMap((op) => {
      const security = (op['security'] ?? defaultSecurity ?? []) as Node[];
      const cookie = security.some((requirement) => 'cookieAuth' in requirement);
      return cookie && typeof op['operationId'] === 'string'
        ? [{ file, operationId: op['operationId'], document, responses: asNode(op['responses']) }]
        : [];
    }),
  );
}

function cookieOps(): CookieOp[] {
  return yamlFiles(CONTRACTS_DIR).flatMap((path) =>
    opsOf(relative(CONTRACTS_DIR, path), parseYaml(readFileSync(path, 'utf8')) as Node),
  );
}

/** The documented 429 of `op`, flattened to what a client sees. */
function console429(op: CookieOp) {
  const response = deref(op.document, op.responses['429']);
  const headers = asNode(response['headers']);
  const retryAfter = deref(op.document, headers['Retry-After']);
  const body = deref(
    op.document,
    asNode(asNode(asNode(response['content'])['application/json'])['schema']),
  );
  return {
    retryAfter: { required: retryAfter['required'], schema: retryAfter['schema'] },
    cacheControl: asNode(asNode(headers['Cache-Control'])['schema'])['enum'],
    errorEnvelope: Object.keys(
      asNode(asNode(asNode(body['properties'])['error'])['properties']),
    ).sort(),
    description: `${String(response['description'])} ${String(retryAfter['description'])}`,
  };
}

describe('console 429 contract sweep (RT-620 / RT-574 D7)', () => {
  const ops = cookieOps();
  const limited = ops.filter((op) => !EXEMPT.has(op.operationId));

  it('the sweep is not vacuous: every exempt operation is a cookieAuth operation, and 103+ are limited', () => {
    expect(ops.map((op) => op.operationId)).toEqual(expect.arrayContaining([...EXEMPT]));
    expect(limited.length).toBeGreaterThanOrEqual(103);
  });

  it('no exempt operation documents a 429', () => {
    const with429 = ops.filter((op) => EXEMPT.has(op.operationId) && '429' in op.responses);
    expect(with429.map((op) => op.operationId)).toEqual([]);
  });

  it('every other cookieAuth operation documents the console 429', () => {
    const missing = limited.filter((op) => !('429' in op.responses));
    expect(missing.map((op) => `${op.file}: ${op.operationId}`)).toEqual([]);
  });

  it('each 429 carries the bounded Retry-After, no-store and the canonical error envelope', () => {
    const expected = {
      retryAfter: { required: true, schema: { type: 'integer', minimum: 1, maximum: 3600 } },
      cacheControl: ['no-store'],
      // Some files' envelope also carries an optional `details`.
      errorEnvelope: expect.arrayContaining(['code', 'message', 'request_id']),
    };
    for (const op of limited) {
      const { description: _description, ...shape } = console429(op);
      expect({ op: `${op.file}: ${op.operationId}`, ...shape }).toEqual({
        op: `${op.file}: ${op.operationId}`,
        ...expected,
      });
    }
  });

  it('no budget number appears in a documented 429', () => {
    const limits = Object.values(CONSOLE_RATE_LIMIT_BUDGETS).map((b) => String(b.limit));
    const leaks = limited.flatMap((op) => {
      const words = console429(op).description.split(/[^0-9]+/);
      return limits
        .filter((limit) => words.includes(limit))
        .map((limit) => `${op.operationId}: ${limit}`);
    });
    expect(leaks).toEqual([]);
  });
});
