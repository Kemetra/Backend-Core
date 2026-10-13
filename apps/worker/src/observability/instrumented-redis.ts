/**
 * InstrumentedRedis — ioredis subclass that records
 * `redis_command_duration_seconds` observations on every sendCommand call.
 *
 * Design notes
 * ============
 * - Override point: `sendCommand` is the single ioredis method through which
 *   every Redis command flows (pipeline, multi, and standalone). The return
 *   value is typed `unknown`; most invocations resolve as Promises, but
 *   pipeline/cluster contexts may return synchronous values. A thenable guard
 *   ensures `.then()` is only called on actual Promises, recording duration
 *   on both the synchronous and async paths.
 *
 * - Bounded label set: FR-B-006 forbids unbounded cardinality.
 *   `KNOWN_REDIS_COMMANDS` is the closed set of BullMQ-relevant command
 *   verbs; anything not in the set is bucketed as `"other"`.
 *
 * - `duplicate()` override: BullMQ's `Worker` constructor calls
 *   `connection.duplicate()` to create a separate blocking connection (used
 *   for BRPOP). Without the override, `duplicate()` returns a plain `Redis`
 *   instance and the blocking connection is un-instrumented. The override
 *   returns a new `InstrumentedRedis` so both connections carry the hook.
 *
 * - No `outcome` label: `redis_command_duration_seconds` is defined with
 *   only a `command` label (see `assertMetricLabels` in worker.metrics.ts).
 *   Duration is recorded on both success and error paths regardless.
 *
 * - BullMQ-compatible defaults: BullMQ's `Worker` constructor rejects any
 *   pre-built ioredis client whose `maxRetriesPerRequest` is not `null`
 *   (the BRPOPLPUSH path must be allowed to retry forever — a finite
 *   per-command retry budget would corrupt job semantics). It also expects
 *   `enableReadyCheck: false` on the blocking connection. ioredis's stock
 *   defaults (`maxRetriesPerRequest: 20`, `enableReadyCheck: true`) cause
 *   the worker process to throw at boot:
 *     "BullMQ: Your redis options maxRetriesPerRequest must be null."
 *   We centralise the two BullMQ-safe defaults inside the constructor so
 *   every call site (`BullMqWorkerFactory`, `QueueLagGaugeRegistrar`,
 *   `duplicate()`-spawned blocking connections, tests) inherits them
 *   automatically. Caller-supplied options still win — pass an explicit
 *   `maxRetriesPerRequest: 5` and the override is honoured.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W4.
 */
import { Redis, Command, type RedisOptions } from "ioredis";

import { recordRedisCommandDuration } from "./metrics/worker.metrics";

// ---------------------------------------------------------------------------
// Bounded command label set (FR-B-006)
// ---------------------------------------------------------------------------

/**
 * Closed set of Redis command verbs used by BullMQ and the worker pipelines.
 * Any command not in this set is recorded with label `command = "other"`.
 * Adding a new entry requires a corresponding `ALLOWED_METRIC_LABELS` update
 * (packages/shared) — do NOT widen without that gate.
 */
export const KNOWN_REDIS_COMMANDS: ReadonlySet<string> = new Set([
  "del",
  "eval",
  "evalsha",
  "exists",
  "expire",
  "get",
  "hget",
  "hdel",
  "hgetall",
  "hmget",
  "hset",
  "llen",
  "lpop",
  "lpush",
  "multi",
  "exec",
  "ping",
  "pexpire",
  "rpush",
  "sadd",
  "set",
  "scard",
  "smembers",
  "srem",
  "subscribe",
  "publish",
  "zadd",
  "zcard",
  "zcount",
  "zrange",
  "zrangebyscore",
  "zrem",
  "zremrangebyscore",
]);

/**
 * Normalise a raw command name to the bounded label set.
 * Returns the lowercase name if it is in `KNOWN_REDIS_COMMANDS`, else `"other"`.
 */
export function normalizeCommand(name: string): string {
  const lower = name.toLowerCase();
  return KNOWN_REDIS_COMMANDS.has(lower) ? lower : "other";
}

// ---------------------------------------------------------------------------
// BullMQ-compatible safe defaults
// ---------------------------------------------------------------------------

/**
 * Options every `InstrumentedRedis` instance carries unless the caller
 * explicitly overrides them. Centralising the two BullMQ requirements here
 * prevents call-site drift (`new InstrumentedRedis(url)` is the natural
 * shape; every site would otherwise have to remember the merge).
 *
 * - `maxRetriesPerRequest: null` — BullMQ rejects pre-built clients where
 *   this is finite. ioredis defaults to `20`.
 * - `enableReadyCheck: false` — BullMQ does its own readiness handshake;
 *   the ioredis INFO-loop ready check races BullMQ's connect path on the
 *   blocking connection. ioredis defaults to `true`.
 */
export const BULLMQ_SAFE_REDIS_DEFAULTS: Readonly<
  Pick<RedisOptions, "maxRetriesPerRequest" | "enableReadyCheck">
> = Object.freeze({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Merge `BULLMQ_SAFE_REDIS_DEFAULTS` into the constructor argument list of
 * an ioredis `Redis` overload. The defaults go FIRST so an explicit
 * caller-supplied option (e.g. `{ maxRetriesPerRequest: 5 }`) wins.
 *
 * Heuristic for identifying the options object: ioredis's declared
 * overloads place the `RedisOptions` argument last when present, and it
 * is always a plain object literal (never `null`, never a `Buffer`, never
 * an array, never a URL instance — none of those shapes are valid ioredis
 * inputs). If the trailing arg fails the shape check we append a fresh
 * defaults-only options object instead.
 */
function withBullMqSafeDefaults(args: unknown[]): unknown[] {
  const last = args.at(-1);
  const lastIsOptions =
    last !== null &&
    last !== undefined &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    !(last instanceof Date);
  if (lastIsOptions) {
    const merged = { ...BULLMQ_SAFE_REDIS_DEFAULTS, ...(last as RedisOptions) };
    const copy = args.slice();
    copy[copy.length - 1] = merged;
    return copy;
  }
  return [...args, { ...BULLMQ_SAFE_REDIS_DEFAULTS }];
}

// ---------------------------------------------------------------------------
// Instrumented subclass
// ---------------------------------------------------------------------------

/**
 * ioredis `Redis` subclass that hooks `sendCommand` to record
 * `redis_command_duration_seconds` on every command resolved or rejected.
 *
 * Pass an instance of this class wherever a BullMQ `Queue` or `Worker`
 * accepts a `connection` option. BullMQ will use it for all non-blocking
 * commands, and `duplicate()` ensures the blocking connection carries the
 * same instrumentation.
 *
 * The constructor merges `BULLMQ_SAFE_REDIS_DEFAULTS` (`maxRetriesPerRequest:
 * null`, `enableReadyCheck: false`) into the options object so any
 * pre-built client handed to BullMQ boots cleanly without per-call-site
 * boilerplate. Caller-supplied values for those keys still win.
 */
export class InstrumentedRedis extends Redis {
  // Mirror the ioredis overload set so call sites keep the same shapes.
  // The single rest-parameter implementation forwards to `super` after
  // injecting BullMQ-safe defaults into the options argument.
  constructor(port: number, host: string, options: RedisOptions);
  constructor(path: string, options: RedisOptions);
  constructor(port: number, options: RedisOptions);
  constructor(port: number, host: string);
  constructor(options: RedisOptions);
  constructor(port: number);
  constructor(path: string);
  constructor();
  constructor(...args: unknown[]) {
    // The variadic spread does not align with any single declared
    // overload of `Redis` (each overload is fixed-arity), so TypeScript
    // refuses `super(...args)` directly. ioredis's runtime parser
    // accepts any of the documented shapes — we forward unchanged after
    // injecting the BullMQ-safe defaults. The double-cast through
    // `unknown` keeps this a typed escape rather than a wholesale `any`.
    const finalArgs = withBullMqSafeDefaults(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(...(finalArgs as unknown as [any, any, any]));
  }

  /**
   * Returns a new `InstrumentedRedis` with the same options so BullMQ's
   * blocking connection (created via `connection.duplicate()`) is also
   * instrumented. Without this override, `duplicate()` returns a plain
   * `Redis` instance.
   *
   * The constructor merges `BULLMQ_SAFE_REDIS_DEFAULTS` before any
   * caller-supplied options, so the duplicate inherits the safe defaults
   * by default. If either `this.options` or `override` carries an
   * explicit `maxRetriesPerRequest` / `enableReadyCheck`, that value
   * still wins — the intentional escape hatch for non-BullMQ paths
   * (admin tooling, ad-hoc clients). Production worker call sites must
   * not override these keys; the test suite asserts the defaults shape.
   */
  override duplicate(override?: Partial<RedisOptions>): InstrumentedRedis {
    return new InstrumentedRedis({ ...this.options, ...override });
  }

  /**
   * Wraps the base-class `sendCommand` to record duration in seconds.
   * Duration is recorded on both resolve and reject — the metric tracks
   * total round-trip time regardless of outcome.
   *
   * A thenable guard handles the rare synchronous-return path (pipeline/
   * cluster contexts) so that calling `.then()` on a non-Promise never
   * throws a runtime error.
   */
  override sendCommand(
    command: Command,
    stream?: Parameters<Redis["sendCommand"]>[1],
  ): unknown {
    const start = performance.now();
    const result = super.sendCommand(command, stream);
    if (
      result === null ||
      typeof (result as { then?: unknown }).then !== "function"
    ) {
      recordRedisCommandDuration(
        { command: normalizeCommand(command.name) },
        (performance.now() - start) / 1000,
      );
      return result;
    }
    return (result as Promise<unknown>).then(
      (v: unknown) => {
        recordRedisCommandDuration(
          { command: normalizeCommand(command.name) },
          (performance.now() - start) / 1000,
        );
        return v;
      },
      (err: unknown) => {
        recordRedisCommandDuration(
          { command: normalizeCommand(command.name) },
          (performance.now() - start) / 1000,
        );
        throw err;
      },
    );
  }
}
