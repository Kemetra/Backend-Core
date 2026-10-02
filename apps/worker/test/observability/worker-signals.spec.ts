/**
 * T465 — Worker / queue / Redis signal-presence test.
 *
 * Verifies that every worker-side metric defined in
 * `docs/observability/signals.md` §3 is:
 *   1. Registered in the `ALLOWED_METRIC_LABELS` closed allowlist
 *      (`packages/shared/src/observability/metrics-labels.ts`).
 *   2. Label-policy compliant (no forbidden labels; all labels in
 *      allowlist).
 *   3. Exposed via a typed emission helper that can be called without
 *      throwing — for the seven emit-now signals.
 *   4. For the three Track C outbox placeholders: registered as
 *      definitions only; no emission helper expected (plan §6).
 *
 * Scope: in-process module-load assertions. No live Redis, no live
 * BullMQ, no Testcontainers, no Nest app, no SDK boot — pure module
 * import + helper invocation. The OTel Meter returned by
 * `getMeter("worker")` is a no-op until a MetricReader is registered;
 * helpers call through to it safely.
 *
 * The full `/metrics` HTTP scrape (T483 worker subset) is deferred to a
 * separate package-gated slice — it requires `@opentelemetry/sdk-metrics`
 * + `@opentelemetry/exporter-prometheus`, which this slice is not
 * authorised to add.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / T465.
 */
import {
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";
import {
  WORKER_METRIC_NAMES,
  WORKER_OUTBOX_METRIC_NAMES,
  WORKER_OUTBOX_EVENT_TYPES,
  WORKER_QUEUE_NAMES,
  WORKER_DELIVERY_QUEUE_LABELS,
  WORKER_JOB_NAMES,
  WORKER_ERROR_CLASSES,
  createQueueLagCallback,
  recordOutboxDeadLetter,
  recordOutboxDrainDuration,
  recordQueueDeadLetter,
  recordQueueFailed,
  recordQueueRetry,
  recordRedisCommandDuration,
  recordWorkerJobDuration,
  recordWorkerProcessingFailure,
  registerDbPoolGauges,
  registerOutboxPendingGauge,
  registerQueueLagGauge,
  sanitizeErrorClass,
} from "../../src/observability/metrics/worker.metrics";
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import { EMAIL_QUEUE_NAME } from "../../src/email/email.worker";
import { AUDIT_QUEUE_NAME } from "../../src/audit/audit.worker";
import { AUDIT_RETENTION_QUEUE_NAME } from "../../src/audit/audit-retention.worker";
import { SALE_PROCESSING_QUEUE_NAME } from "../../src/sales/sale.worker";
import { OUTBOX_RETENTION_QUEUE_NAME } from "../../src/outbox/retention.worker";
import { OUTBOX_AUDIT_QUEUE_NAME } from "../../src/outbox/consumers/audit-event-created.consumer";
import { OUTBOX_SALE_PROCESSING_QUEUE_NAME } from "../../src/outbox/consumers/sale-captured.consumer";

// ---------------------------------------------------------------------------
// 1. Signal-name registry: every worker metric is in ALLOWED_METRIC_LABELS
// ---------------------------------------------------------------------------

describe("T465 — signal presence: every worker metric is in ALLOWED_METRIC_LABELS", () => {
  for (const name of WORKER_METRIC_NAMES) {
    it(`registers "${name}"`, () => {
      expect(ALLOWED_METRIC_LABELS[name]).toBeDefined();
    });
  }

  it("WORKER_METRIC_NAMES covers the two P4-W1 DB pool signals, the P4-W5 slow-query counter, the seven base worker signals, and all three T595 outbox signals", () => {
    const expected = [
      // P4 W1: DB pool gauges (worker scrapes its own AuditDbPool on port 9091)
      "db_pool_in_use",
      "db_pool_waiters",
      // P4 W5: slow-query counter
      "db_slow_query_total",
      "redis_command_duration_seconds",
      // P4 W2: queue lag observable gauge
      "queue_lag_seconds",
      "queue_failed_total",
      "queue_dead_letter_total",
      "queue_retry_total",
      "worker_job_duration_seconds",
      "worker_processing_failure_total",
      // T595 PR-B-1: graduated from WORKER_OUTBOX_METRIC_NAMES
      "outbox_dead_letter_total",
      "outbox_drain_duration_seconds",
      // T595 PR-B-2: ObservableGauge with scrape-time addCallback
      "outbox_pending_total",
      // 015-POLISH: posting reconciliation / DLQ flag, emitted by the worker
      // PostingRequestedConsumer on a 015-RESOLVE creation-time rejection.
      "erpnext_posting_reconciliation_total",
    ];
    expect([...WORKER_METRIC_NAMES].sort()).toEqual([...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Track C outbox placeholders: tombstone — all signals graduated.
//    WORKER_OUTBOX_METRIC_NAMES is now empty (T595 PR-B-2 graduated the
//    final placeholder, outbox_pending_total).
// ---------------------------------------------------------------------------

describe("T465 — outbox placeholders: tombstone (all signals graduated post-PR-B-2)", () => {
  it("WORKER_OUTBOX_METRIC_NAMES is empty (all three T595 signals now emit)", () => {
    expect([...WORKER_OUTBOX_METRIC_NAMES]).toEqual([]);
  });

  it("outbox placeholder names are disjoint from emit-now worker names (vacuously true)", () => {
    const intersect = WORKER_OUTBOX_METRIC_NAMES.filter((n) =>
      (WORKER_METRIC_NAMES as readonly string[]).includes(n),
    );
    expect(intersect).toEqual([]);
  });

  it("all three T595 outbox signals are now in WORKER_METRIC_NAMES, not WORKER_OUTBOX_METRIC_NAMES", () => {
    const graduated = [
      "outbox_dead_letter_total",
      "outbox_drain_duration_seconds",
      "outbox_pending_total",
    ];
    for (const name of graduated) {
      expect((WORKER_METRIC_NAMES as readonly string[]).includes(name)).toBe(true);
      expect((WORKER_OUTBOX_METRIC_NAMES as readonly string[]).includes(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Label policy: every registered label obeys the allowlist
// ---------------------------------------------------------------------------

describe("T465 — label policy: every worker metric's labels pass validateMetricLabels", () => {
  const allNames = [...WORKER_METRIC_NAMES, ...WORKER_OUTBOX_METRIC_NAMES] as const;

  for (const name of allNames) {
    const allowed = ALLOWED_METRIC_LABELS[name] ?? [];

    it(`"${name}" passes with its full allowed label set`, () => {
      expect(validateMetricLabels(name, allowed)).toBeNull();
    });

    it(`"${name}" passes with an empty label set (subset is allowed)`, () => {
      expect(validateMetricLabels(name, [])).toBeNull();
    });

    it(`"${name}" rejects tenant_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["tenant_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects store_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["store_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects user_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["user_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects actor_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["actor_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects job_id (unbounded — plan §8)`, () => {
      const result = validateMetricLabels(name, ["job_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects correlation_id (unbounded — plan §8)`, () => {
      const result = validateMetricLabels(name, ["correlation_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });
  }

  it("no worker metric's allowed labels intersect FORBIDDEN_METRIC_LABELS", () => {
    const offenders: Array<{ metric: string; label: string }> = [];
    for (const name of allNames) {
      const allowed = ALLOWED_METRIC_LABELS[name] ?? [];
      for (const label of allowed) {
        if (FORBIDDEN_METRIC_LABELS.has(label)) {
          offenders.push({ metric: name, label });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Bounded enums (queue_name / job_name / error_class)
// ---------------------------------------------------------------------------

describe("T465 — bounded enums: queue, job_name, and error_class are documented", () => {
  it("RT-125: WORKER_QUEUE_NAMES is exactly the five queues the worker consumes", () => {
    const expected = [
      "email",
      "audit",
      "audit-retention",
      "sale-processing",
      "outbox-retention",
    ];
    expect([...WORKER_QUEUE_NAMES].sort()).toEqual([...expected].sort());
  });

  it("RT-125: WORKER_QUEUE_NAMES is the shared QUEUE_NAMES set (producers, consumers and gauge agree)", () => {
    expect([...WORKER_QUEUE_NAMES].sort()).toEqual(Object.values(QUEUE_NAMES).sort());
  });

  it("RT-125: every consumer's queue constant is in the observed set", () => {
    for (const name of [
      EMAIL_QUEUE_NAME,
      AUDIT_QUEUE_NAME,
      AUDIT_RETENTION_QUEUE_NAME,
      SALE_PROCESSING_QUEUE_NAME,
      OUTBOX_RETENTION_QUEUE_NAME,
      OUTBOX_AUDIT_QUEUE_NAME,
      OUTBOX_SALE_PROCESSING_QUEUE_NAME,
    ]) {
      expect(WORKER_QUEUE_NAMES).toContain(name);
    }
  });

  it("RT-125: delivery-counter labels add only the outbox drainer", () => {
    expect([...WORKER_DELIVERY_QUEUE_LABELS].sort()).toEqual(
      [...WORKER_QUEUE_NAMES, "outbox-drainer"].sort(),
    );
  });

  it("WORKER_JOB_NAMES is unchanged by RT-125 (no job-label churn)", () => {
    expect([...WORKER_JOB_NAMES].sort()).toEqual(
      ["audit-fanout", "audit-retention", "email", "session-revoke", "soft-delete-sweep"],
    );
  });

  it("WORKER_ERROR_CLASSES contains the plan §7.1 allowlist (including UnknownError catch-all)", () => {
    const expected = [
      "TenantContextMissingError",
      "ZodValidationError",
      "PostgresUniqueViolation",
      "RedisConnectionError",
      "Timeout",
      "UnknownError",
    ];
    expect([...WORKER_ERROR_CLASSES].sort()).toEqual([...expected].sort());
  });

  it("WORKER_ERROR_CLASSES includes the UnknownError catch-all (plan §7.1)", () => {
    expect((WORKER_ERROR_CLASSES as readonly string[]).includes("UnknownError")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. sanitizeErrorClass — closed-allowlist coercion (plan §7.1)
// ---------------------------------------------------------------------------

describe("T465 — sanitizeErrorClass: closed-allowlist coercion (plan §7.1)", () => {
  for (const cls of WORKER_ERROR_CLASSES) {
    it(`passes the allowed class "${cls}" through unchanged`, () => {
      expect(sanitizeErrorClass(cls)).toBe(cls);
    });
  }

  it("coerces an unknown class name to UnknownError", () => {
    expect(sanitizeErrorClass("SomeNeverDeclaredError")).toBe("UnknownError");
  });

  it("coerces undefined to UnknownError", () => {
    expect(sanitizeErrorClass(undefined)).toBe("UnknownError");
  });

  it("coerces null to UnknownError", () => {
    expect(sanitizeErrorClass(null)).toBe("UnknownError");
  });

  it("coerces a non-string (defensive) to UnknownError", () => {
    // Caller is expected to pass `err.constructor.name` (always a string),
    // but the sanitizer must be robust to a malformed input rather than
    // throw — a metric emit site must never crash worker job processing.
    expect(sanitizeErrorClass(42 as unknown as string)).toBe("UnknownError");
  });
});

// ---------------------------------------------------------------------------
// 6. Helpers are callable — no throw, no SDK required
// ---------------------------------------------------------------------------

describe("T465 — emission helpers: callable without a live MetricReader", () => {
  it("recordRedisCommandDuration does not throw for common Redis verbs", () => {
    for (const command of ["get", "set", "del", "hget", "hset"]) {
      expect(() =>
        recordRedisCommandDuration({ command }, 0.001),
      ).not.toThrow();
    }
  });

  it("recordQueueFailed does not throw for each queue × allowed error_class", () => {
    for (const queue of WORKER_QUEUE_NAMES) {
      for (const error_class of WORKER_ERROR_CLASSES) {
        expect(() =>
          recordQueueFailed({ queue, error_class }),
        ).not.toThrow();
      }
    }
  });

  it("recordQueueDeadLetter does not throw for each queue", () => {
    for (const queue of WORKER_QUEUE_NAMES) {
      expect(() => recordQueueDeadLetter({ queue })).not.toThrow();
    }
  });

  it("recordQueueRetry does not throw for each queue", () => {
    for (const queue of WORKER_QUEUE_NAMES) {
      expect(() => recordQueueRetry({ queue })).not.toThrow();
    }
  });

  it("recordWorkerJobDuration does not throw for each job_name", () => {
    for (const job_name of WORKER_JOB_NAMES) {
      expect(() =>
        recordWorkerJobDuration({ job_name }, 0.05),
      ).not.toThrow();
    }
  });

  it("recordWorkerProcessingFailure does not throw for each job_name × allowed error_class", () => {
    for (const job_name of WORKER_JOB_NAMES) {
      for (const error_class of WORKER_ERROR_CLASSES) {
        expect(() =>
          recordWorkerProcessingFailure({ job_name, error_class }),
        ).not.toThrow();
      }
    }
  });

  // T595 PR-B-1 — new outbox helpers
  it("recordOutboxDeadLetter does not throw for each bounded event_type", () => {
    for (const event_type of WORKER_OUTBOX_EVENT_TYPES) {
      expect(() => recordOutboxDeadLetter({ event_type })).not.toThrow();
    }
  });

  it("recordOutboxDeadLetter does not throw for a string event_type outside the bounded set", () => {
    // The drainer accepts row.event_type as untyped string (a row may carry an
    // event_type with no registered consumer — UnroutableEventType path). The
    // helper signature widens to `string` to preserve diagnostic visibility;
    // emission must not crash on values outside WORKER_OUTBOX_EVENT_TYPES.
    expect(() => recordOutboxDeadLetter({ event_type: "test.event.poison" })).not.toThrow();
  });

  it("recordOutboxDrainDuration does not throw for each bounded event_type", () => {
    for (const event_type of WORKER_OUTBOX_EVENT_TYPES) {
      expect(() => recordOutboxDrainDuration({ event_type }, 0.05)).not.toThrow();
    }
  });

  it("recordOutboxDrainDuration accepts a zero duration (per-row claim-immediate-fail path)", () => {
    expect(() =>
      recordOutboxDrainDuration({ event_type: "audit.event.created" }, 0),
    ).not.toThrow();
  });

  // P4 W1 — db_pool_in_use + db_pool_waiters ObservableGauge registrar
  it("registerDbPoolGauges is exported and callable with pool=null (no-DB path)", () => {
    const result = registerDbPoolGauges({ pool: null });
    expect(result).toBeDefined();
    expect(typeof result.stop).toBe("function");
    expect(() => result.stop()).not.toThrow();
  });

  it("registerDbPoolGauges no-DB path is idempotent: many calls + stops do not throw", () => {
    for (let i = 0; i < 5; i++) {
      const result = registerDbPoolGauges({ pool: null });
      expect(() => result.stop()).not.toThrow();
    }
  });

  // P4 W2 — queue_lag_seconds ObservableGauge registrar
  it("registerQueueLagGauge is exported and callable with queues=null (no-Redis path)", () => {
    const result = registerQueueLagGauge({ queues: null });
    expect(result).toBeDefined();
    expect(typeof result.stop).toBe("function");
    expect(() => result.stop()).not.toThrow();
  });

  it("registerQueueLagGauge no-Redis path is idempotent: many calls + stops do not throw", () => {
    for (let i = 0; i < 5; i++) {
      const result = registerQueueLagGauge({ queues: null });
      expect(() => result.stop()).not.toThrow();
    }
  });

  // T595 PR-B-2 — outbox_pending_total ObservableGauge registrar
  it("registerOutboxPendingGauge is exported and callable with pool=null (no-DB path)", () => {
    const result = registerOutboxPendingGauge({ pool: null });
    expect(result).toBeDefined();
    expect(typeof result.stop).toBe("function");
    // stop() must be safe to call even on the no-op path.
    expect(() => result.stop()).not.toThrow();
  });

  it("registerOutboxPendingGauge no-DB path is idempotent: many calls + stops do not throw", () => {
    for (let i = 0; i < 5; i++) {
      const result = registerOutboxPendingGauge({ pool: null });
      expect(() => result.stop()).not.toThrow();
    }
  });
});
