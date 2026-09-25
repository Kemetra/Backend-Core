/**
 * IdempotencyInterceptor — T520.
 *
 * NestJS interceptor that enforces HTTP idempotency for routes annotated
 * with `@Idempotent(policy)`.
 *
 * Flow (strategy.md §3.4.3):
 *   1. Read `@Idempotent` metadata. No metadata → pass through.
 *   2. Extract `Idempotency-Key` header; enforce policy (required → 400 if missing).
 *   3. Validate header format (16–128 chars, printable ASCII, no whitespace).
 *   4. Compose dedup tuple: `${method}:${route}:${clientId}:${key}`.
 *   5. Check in-progress marker. Present → 425 Too Early.
 *   6. Check IdempotencyKeyStore. Hit → return cached response (replay).
 *                                   Collision → 409 Conflict.
 *   7. Set in-progress marker.
 *   8. Invoke handler. On success → save to store; on any exit → clear marker.
 *
 * Redaction policy (strategy.md §15 / redaction-matrix):
 *   - Raw `Idempotency-Key` is NEVER logged. Only `key_fingerprint`
 *     (SHA-256 first 8 hex chars) may appear in structured logs.
 *
 * Replay path short-circuits BEFORE the handler → no second audit event
 * (strategy.md §6.4). `AuditEmitterInterceptor` is a global APP_INTERCEPTOR
 * but the `invite` route has no `@Auditable` decorator, so audit is a
 * no-op on that route regardless.
 *
 * Constitution §VII / FR-D-001 / FR-D-002 / FR-D-007 / FR-D-009.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { EMPTY, Observable, from, of } from "rxjs";
import { catchError, concatMap, finalize, switchMap } from "rxjs/operators";

import { IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";
import type { StoredResult } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../audit/audit-job.types";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { ResolvedContext } from "../context/types";
import {
  IDEMPOTENT_OPTIONS_KEY,
  IDEMPOTENT_POLICY_KEY,
  type IdempotentOptions,
  type IdempotentPolicy,
} from "./idempotent.decorator";
import { canonicalJson } from "./canonical-json";
import {
  DEFAULT_INFLIGHT_TTL_SEC,
  InProgressMarker,
} from "./in-progress-marker";
import {
  recordIdempotencyConflict,
  recordIdempotencyInProgress,
  recordIdempotencyReplay,
  recordIdempotencyTokenMismatch,
} from "../observability/metrics/api.metrics";

export const IDEMPOTENCY_KEY_STORE = Symbol.for("api.idempotency.store");

/** Header name — case-insensitive per RFC. Express lowercases incoming headers. */
const HEADER_NAME = "idempotency-key";

/** Valid printable ASCII, no whitespace, 16–128 chars. */
const KEY_REGEX = /^[\x21-\x7E]{16,128}$/;

/** Route template used in the dedup tuple — method + path template. */
function routeTemplate(ctx: ExecutionContext): string {
  const req = ctx.switchToHttp().getRequest<{ method: string; route?: { path?: string }; url: string }>();
  const method = req.method.toUpperCase();
  const path = req.route?.path ?? req.url;
  return `${method}:${path}`;
}

/**
 * Extract clientId from the resolved context.
 * Falls back to "anonymous" only when the tenant context is absent
 * (should never happen on routes that use TenantContextGuard).
 */
function clientId(ctx: ExecutionContext): string {
  const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
  return req.context?.userId ?? req.principal?.userId ?? "anonymous";
}

function tenantId(ctx: ExecutionContext): string | null {
  const req = ctx
    .switchToHttp()
    .getRequest<{
      context?: ResolvedContext;
      principal?: { tenantId?: string | null };
    }>();
  // Fall back to the authenticated principal's tenant when the resolved context
  // is absent — connector-facing routes (@UseGuards(ConnectorAuthGuard), e.g. the
  // 015 posting-ack + 019 bin-view-report surfaces) do NOT run TenantContextGuard,
  // so `req.context` is undefined there. Without this fallback the partition tenant
  // collapses to null/"no-tenant" and idempotency keys collide ACROSS tenants
  // (a connector credential issued by the same human admin in two tenants shares a
  // partition) — a cross-tenant dedup/replay leak (#530). The connector token
  // principal carries a non-null `tenantId`; mirror the `clientId` principal
  // fallback above so the partition is always tenant-scoped.
  return req.context?.tenantId ?? req.principal?.tenantId ?? null;
}

/** SHA-256 of a string, returned as a Buffer. */
function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** First 8 hex chars of SHA-256 of the header value — safe to log. */
function keyFingerprint(headerValue: string): string {
  return createHash("sha256").update(headerValue).digest("hex").slice(0, 8);
}

/** Canonical JSON fingerprint of the request body. */
export function bodyFingerprint(body: unknown): Buffer {
  return sha256Buffer(canonicalJson(body ?? null));
}

/**
 * Replay-store key. Tenant is already a separate partition on the store,
 * so this string stays stable across the #614 marker fix.
 */
function composeStoreKey(
  method: string,
  routePath: string,
  cId: string,
  headerKey: string,
): string {
  return `${method}:${routePath}:${cId}:${headerKey}`;
}

/**
 * In-flight marker tuple. Tenant is part of the namespace: the same user
 * in two tenants must not block the other with 425.
 */
export function composeTuple(tenantId: string, storeKey: string): string {
  return `${tenantId}:${storeKey}`;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_KEY_STORE) private readonly store: IdempotencyKeyStore,
    private readonly marker: InProgressMarker,
    // Catalog-domain telemetry on the collision branch — FR-021c (counter)
    // and FR-082 (audit subject) for the 005 unknown-items capture route.
    // Inlined here because NestJS interceptor execution order means a
    // downstream route-level interceptor's tap.error never observes a
    // ConflictException thrown by this APP_INTERCEPTOR BEFORE invoking
    // next.handle() — the inner chain is never subscribed.
    // Both deps are @Optional so this interceptor remains usable in
    // legacy/non-catalog test fixtures that don't wire AuditModule.
    // Architectural pivot context: specs/005-pos-catalog-sync-reconciliation/wave-status.md
    // §"Investigation update — 2026-05-28 (PR #386 CI evidence)" +
    // PR #389 CI evidence that the route-level interceptor pattern never
    // fired the side effect (mismatchCounter stayed 0).
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly auditEnqueuer: AuditJobEnqueuer | null = null,
    @Optional()
    @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.get<IdempotentPolicy | undefined>(
      IDEMPOTENT_POLICY_KEY,
      execCtx.getHandler(),
    );

    // No @Idempotent decorator → pass through.
    if (!policy) {
      return next.handle();
    }

    const options = this.reflector.get<IdempotentOptions>(
      IDEMPOTENT_OPTIONS_KEY,
      execCtx.getHandler(),
    ) ?? {};

    return from(this.handle(execCtx, next, policy, options)).pipe(
      switchMap((obs) => obs),
    );
  }

  private async handle(
    execCtx: ExecutionContext,
    next: CallHandler,
    policy: IdempotentPolicy,
    options: IdempotentOptions,
  ): Promise<Observable<unknown>> {
    const req = execCtx.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();

    const rawKey = req.headers[HEADER_NAME];
    const headerValue = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Step 2: enforce policy for missing header
    if (!headerValue) {
      if (policy === "required") {
        throw new BadRequestException({
          code: "idempotency_key_required",
          message:
            "This endpoint requires an Idempotency-Key header. Generate a UUIDv7 and include it with every retry.",
        });
      }
      // optional: pass through without replay protection
      return next.handle();
    }

    // Step 3: validate header format
    if (!KEY_REGEX.test(headerValue)) {
      throw new BadRequestException({
        code: "idempotency_key_malformed",
        message:
          "Idempotency-Key must be 16–128 printable ASCII characters with no whitespace.",
      });
    }

    const method = req.method.toUpperCase();
    const routePath = req.route?.path ?? req.url;
    const cId = clientId(execCtx);
    const tId = tenantId(execCtx) ?? "no-tenant";
    const route = `${method}:${routePath}`;

    const storeKey = composeStoreKey(method, routePath, cId, headerValue);
    const tuple = composeTuple(tId, storeKey);
    const fp = bodyFingerprint(req.body);

    // Step 5: check in-progress marker BEFORE store lookup.
    const inflightTtlSec = options.inflightTtlSec ?? DEFAULT_INFLIGHT_TTL_SEC;
    const markerOwned = await this.marker.trySet(tuple, inflightTtlSec);

    if (!markerOwned) {
      // Another request is in flight for this tuple.
      recordIdempotencyInProgress({ route });
      // Write the response directly and return EMPTY so NestJS does not
      // attempt a second serialization pass (EMPTY completes with no values).
      const rawRes = execCtx.switchToHttp().getResponse<{
        status(code: number): unknown;
        setHeader(name: string, value: string): void;
        headersSent: boolean;
        json(body: unknown): void;
      }>();
      rawRes.setHeader("Retry-After", "2");
      rawRes.status(425 as unknown as number);
      rawRes.json({ error: "idempotency_in_progress", retryAfterSec: 2 });
      return EMPTY;
    }

    try {
      // Step 6: check IdempotencyKeyStore.
      const replayTtlMs =
        options.replayTtlSec !== undefined
          ? options.replayTtlSec * 1000
          : 72 * 60 * 60 * 1000; // 72h default

      const stored = await this.store.findOrCreate(
        tId,
        null,
        cId,
        storeKey,
        fp,
      );

      if (stored.hit === true) {
        // Replay path — short-circuit before handler.
        await this.marker.del(tuple);
        recordIdempotencyReplay({ route });
        const entry = stored.entry;
        const rawRes = execCtx.switchToHttp().getResponse<{
          status(code: number): unknown;
          setHeader(name: string, value: string): void;
          json(body: unknown): void;
        }>();
        rawRes.setHeader("Idempotent-Replayed", "true");
        rawRes.status(entry.result.status);
        rawRes.json(entry.result.body);
        return EMPTY;
      }

      if (stored.hit === "collision") {
        // Same key, different body — conflict.
        await this.marker.del(tuple);
        // Platform-axis observability (001): operator-dashboard counter.
        // Fires for EVERY idempotent route's collision — this is the
        // cross-cutting platform signal and is intentionally unscoped.
        recordIdempotencyConflict({ route });
        // The catalog-axis side effects below (FR-021c counter + FR-082
        // audit subject) are domain-specific to the 005 unknown-items
        // capture route and MUST NOT fire for unrelated idempotent routes
        // (e.g. POST /api/v1/memberships/invite). This global APP_INTERCEPTOR
        // sees every @Idempotent route, so we gate on the route template.
        // `routePath` is `req.route?.path` (or `req.url`); we match by
        // suffix so the check is agnostic to Express's leading-slash
        // normalization and to any future mount-prefix changes. The
        // `:id`-suffixed sibling routes (dismiss/link/create-product) do
        // not match `/catalog/unknown-items` exactly, so this is precise.
        // No HTTP-verb guard is needed: the only OTHER route whose path
        // ends in `/catalog/unknown-items` is the GET LIST endpoint, which
        // carries no @Idempotent decorator and so never reaches this
        // collision branch. A `method === "POST"` arm here would be a
        // permanently-uncovered branch (collision is POST-only by routing).
        const isUnknownItemsCaptureRoute =
          routePath.endsWith("/catalog/unknown-items");
        // Catalog-axis observability (005 FR-021c): per-tenant capture-flow
        // counter. Co-increments with the platform counter on a capture-route
        // collision — intentional, see signals.md §1.1.
        if (isUnknownItemsCaptureRoute) {
          recordIdempotencyTokenMismatch();
        }
        // Catalog-domain audit subject (005 FR-082): fire-and-forget.
        // The enqueue promise is NOT awaited — if the audit pipeline
        // rejects (BullMQ outage, Redis disconnect), the 409 contract
        // must NOT be replaced by an audit failure. The .catch() logs
        // and swallows. Mirrors AuditEmitterInterceptor's pattern.
        // Skipped when not on the capture route, or when AUDIT_JOB_ENQUEUER
        // is not wired (legacy test fixtures that don't import AuditModule).
        if (isUnknownItemsCaptureRoute && this.auditEnqueuer !== null) {
          const principal = req.principal;
          const ctx = req.context;
          const requestId = (req as unknown as { requestId?: string })
            .requestId;
          const payload: AuditJobPayload = {
            actor_user_id: principal?.userId ?? null,
            actor_label: null,
            tenant_id: ctx?.tenantId ?? null,
            store_id: ctx?.storeId ?? null,
            action: "unknown_item.idempotency_mismatch_rejected",
            target_type: null,
            target_id: null,
            request_id: requestId ?? null,
            metadata: null,
          };
          this.auditEnqueuer.enqueue(payload).catch((err: unknown) => {
            this.logger?.error(
              { err, action: payload.action },
              "IdempotencyInterceptor: catalog audit enqueue failed on collision",
            );
          });
        }
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
        });
      }

      return runFresh({
        store: this.store,
        marker: this.marker,
        logger: this.logger,
        execCtx,
        next,
        route,
        tuple,
        tenantId: tId,
        clientId: cId,
        storeKey,
        fingerprint: fp,
        replayTtlMs,
        hit: stored.hit,
        keyFingerprint: keyFingerprint(headerValue),
      });
    } catch (err) {
      await this.marker.del(tuple).catch(() => undefined);
      throw err;
    }
  }
}

interface FreshAttempt {
  store: IdempotencyKeyStore;
  marker: InProgressMarker;
  logger: Logger | undefined;
  execCtx: ExecutionContext;
  next: CallHandler;
  route: string;
  tuple: string;
  tenantId: string;
  clientId: string;
  storeKey: string;
  fingerprint: Buffer;
  replayTtlMs: number;
  hit: false | "in_progress";
  keyFingerprint: string;
}

async function runFresh(attempt: FreshAttempt): Promise<Observable<unknown>> {
  if (attempt.hit === "in_progress") {
    await attempt.marker.del(attempt.tuple);
    recordIdempotencyInProgress({ route: attempt.route });
    return replyInProgress(attempt.execCtx);
  }
  const expiresAt = new Date(Date.now() + attempt.replayTtlMs);
  const claimed = await attempt.store.claim({
    tenantId: attempt.tenantId,
    storeId: null,
    clientId: attempt.clientId,
    key: attempt.storeKey,
    fingerprint: attempt.fingerprint,
    expiresAt,
  });
  if (claimed === "conflict") return lostClaim(attempt);
  const keyFp = attempt.keyFingerprint;
  return attempt.next.handle().pipe(
        catchError((err: unknown) => from(attempt.store.releaseClaim({
          tenantId: attempt.tenantId,
          storeId: null,
          clientId: attempt.clientId,
          key: attempt.storeKey,
        }).then(() => {
          throw err;
        }))),
        concatMap(async (responseBody: unknown) => {
            // Save the successful response for future replays.
            // T539a — preserve the handler's actual status (200, 201, 202, …)
            // rather than hard-coding CREATED. Handlers that use
            // `@Res({ passthrough: true })` to branch status (e.g.,
            // 005 unknown-items capture: 200 resolved / 201 unknown) rely on
            // this so replay returns the same status as the original response.
            const result: StoredResult = {
              status: attempt.execCtx.switchToHttp().getResponse<{ statusCode: number }>().statusCode,
              body: responseBody,
            };
            await attempt.store.save(
              attempt.tenantId,
              null,
              attempt.clientId,
              attempt.storeKey,
              attempt.fingerprint,
              result,
              expiresAt,
            ).catch((err: unknown) => {
              // ADR 0010 D1 (audit M-5): the replay-record save is best-effort, but
              // a SILENT failure hides that idempotency is degraded — a later retry
              // re-executes the handler (for settlement intents, which have no second
              // dedup layer, that means duplicate receivable rows). Log+swallow so the
              // degradation is observable; do NOT re-throw (the side effect already
              // happened — failing the request now would only hide it and is
              // incoherent with ADR 0009 D3 fail-open). The metric/alert counter is
              // AD-TOOL-003-phase-gated and lands separately; this is the warn-log half.
              attempt.logger?.warn(
                { err, route: attempt.route, key_fingerprint: keyFp },
                "IdempotencyInterceptor: replay-record save failed; idempotency degraded (response returned, retry may re-execute handler)",
              );
            });
            return responseBody;
          }),
        finalize(() => {
          // Best-effort marker cleanup on any exit (success or error).
          // Runs after concatMap's save promise settles, so a retry cannot
          // pass the marker while the completion write is still in flight.
          attempt.marker.del(attempt.tuple).catch(() => undefined);
        }),
      );
}

async function lostClaim(attempt: FreshAttempt): Promise<Observable<unknown>> {
  const again = await attempt.store.findOrCreate(
    attempt.tenantId,
    null,
    attempt.clientId,
    attempt.storeKey,
    attempt.fingerprint,
  );
  await attempt.marker.del(attempt.tuple);
  if (again.hit === true) {
    recordIdempotencyReplay({ route: attempt.route });
    return replyReplay(attempt.execCtx, again.entry.result.status, again.entry.result.body);
  }
  if (again.hit === "collision") {
    throw new ConflictException({
      code: "idempotency_key_conflict",
      message:
        "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
    });
  }
  if (again.hit === "in_progress") {
    recordIdempotencyInProgress({ route: attempt.route });
    return replyInProgress(attempt.execCtx);
  }
  return runFresh({ ...attempt, hit: false });
}

function replyInProgress(execCtx: ExecutionContext): Observable<never> {
  const rawRes = execCtx.switchToHttp().getResponse<{
    status(code: number): unknown;
    setHeader(name: string, value: string): void;
    json(body: unknown): void;
  }>();
  rawRes.setHeader("Retry-After", "2");
  rawRes.status(425 as unknown as number);
  rawRes.json({ error: "idempotency_in_progress", retryAfterSec: 2 });
  return EMPTY;
}

function replyReplay(
  execCtx: ExecutionContext,
  status: number,
  body: unknown,
): Observable<never> {
  const rawRes = execCtx.switchToHttp().getResponse<{
    status(code: number): unknown;
    setHeader(name: string, value: string): void;
    json(body: unknown): void;
  }>();
  rawRes.setHeader("Idempotent-Replayed", "true");
  rawRes.status(status);
  rawRes.json(body);
  return EMPTY;
}
