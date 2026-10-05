/**
 * Cashier-admissions DTOs (RT-113 BC2).
 *
 * Source of truth: `packages/contracts/openapi/pos-cashier-admissions.openapi.yaml`.
 *
 *   - The admission request is a union on `mode`; each variant is `.strict()`
 *     (= `additionalProperties: false`), so `takeover` on a reconcile,
 *     `offline_admitted_at` on an online request, and any scope field
 *     (`tenant_id`, `branch_id`, `store_id`, `terminal_id`, `device_id`) or
 *     secret (`pin`, …) are a 400.
 *   - `idempotency_key` follows the platform 16–128 printable-ASCII rule.
 *   - There is no scope field anywhere: tenant and store come from the
 *     authenticated device row only (Constitution §II, §XII).
 *   - RT-219: `end` takes an OPTIONAL closed body `{ admission_generation? }`
 *     echoing the opaque generation of an `admitted` response. No body at
 *     all is valid (Express 5 leaves `req.body` undefined), as is `{}`.
 */
import { z } from "zod";

const CashierUserId = z.string().uuid();

const AdmissionIdempotencyKey = z.string().regex(/^[\x21-\x7E]{16,128}$/);

export const OnlineAdmissionSchema = z
  .object({
    mode: z.literal("online"),
    user_id: CashierUserId,
    takeover: z.boolean().optional(),
    idempotency_key: AdmissionIdempotencyKey,
  })
  .strict();

export const ReconcileAdmissionSchema = z
  .object({
    mode: z.literal("reconcile_offline"),
    user_id: CashierUserId,
    offline_admitted_at: z.string().datetime({ offset: true }),
    idempotency_key: AdmissionIdempotencyKey,
  })
  .strict();

export const AdmissionRequestSchema = z.discriminatedUnion("mode", [
  OnlineAdmissionSchema,
  ReconcileAdmissionSchema,
]);

export type AdmissionRequestInput = z.infer<typeof AdmissionRequestSchema>;

/** `{admission_id}` path parameter. */
export const AdmissionIdSchema = z.string().uuid();

/** `AdmissionGeneration`: opaque, 1–64 printable ASCII (RT-219). */
const AdmissionGeneration = z.string().regex(/^[\x21-\x7E]{1,64}$/);

/** `PosCashierAdmissionEndRequest`, optional as a whole (RT-219). */
export const EndRequestSchema = z
  .object({ admission_generation: AdmissionGeneration.optional() })
  .strict()
  .optional();

export type EndRequestInput = z.infer<typeof EndRequestSchema>;

/** `PosCashierAdmissionAdmitted`. */
export interface AdmittedBody {
  readonly kind: "admitted";
  readonly admission_id: string;
  readonly offline_grace_seconds: number;
  readonly admission_ttl_seconds: number;
  readonly server_time: string;
  readonly display_name: string;
  /** Opaque; changes on every grant and renewal (RT-219). */
  readonly admission_generation: string;
}

/** `PosCashierAdmissionActiveElsewhere` — minimum disclosure. */
export interface ActiveElsewhereBody {
  readonly kind: "active_elsewhere";
}

export type AdmissionResponseBody = AdmittedBody | ActiveElsewhereBody;

/** `PosCashierAdmissionEnded`. */
export interface EndedBody {
  readonly kind: "ended";
}

/** `PosCashierRosterEntry`. */
export interface RosterEntry {
  readonly user_id: string;
  readonly operator_id: string;
  readonly display_name: string;
}

/** `PosCashierRosterResponse`. */
export interface RosterBody {
  readonly cashiers: RosterEntry[];
}
