/**
 * RT-648 — shared types and pinned versions for the offline E1 eval harness.
 *
 * Everything here mirrors RT-647 (Confluence 42893382): `E1-EP v1` (evidence
 * pack), `E1-GL v1` (gold label), `E1-BL v1` (baseline) and `e1-gold/1`
 * (dataset). Test tree only: nothing here is imported from `src/`.
 */

export const E1_VERSIONS = {
  pack: "e1-ep/1",
  out: "e1-out/1",
  goldLabel: "e1-gl/1",
  dataset: "e1-gold/1",
  baseline: "e1-bl/1",
  evaluator: "e1-eval/1",
  promptTemplateId: "sync_doctor.explain_sale",
  promptTemplateVersion: "1",
  outputSchemaId: "sync_doctor.explain_sale.output@e1-out/1",
  routeKey: "sync_doctor.explain_sale@v1",
  providerKey: "recorded",
  modelId: "recorded-replay-1",
} as const;

export type Lang = "en" | "ar";
export type SyncStatus = "captured" | "synced" | "failed-retryable" | "failed-needs-repair";
export type ErpState = "posted" | "pending" | "failed" | "unknown";
export type HttpStatus = 200 | 400 | 401 | 403 | 404 | 429 | 500 | "timeout";
export type ActorRole = "owner" | "tenant_admin" | "store_manager" | "device";
export type E1Op =
  | "consoleGetSale"
  | "consoleGetSaleSyncStatus"
  | "consoleGetSaleAuditTimeline"
  | "consoleListPostingBacklog";

export const E1_CLASSES = [
  "answer",
  "abstain_missing",
  "abstain_stale",
  "abstain_unauthorized",
  "refuse_unsafe",
] as const;
export type E1Class = (typeof E1_CLASSES)[number];

export const E1_BOUNDARIES = [
  "none_failed",
  "bc_sale_processing",
  "erp_sale_posting",
  "erp_reversal_posting",
  "undetermined",
  "not_applicable",
] as const;
export type E1Boundary = (typeof E1_BOUNDARIES)[number];

/** Keeps `unknown` payloads explicit: a frozen JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export interface E1Read {
  readonly op: E1Op;
  readonly route: string;
  readonly http_status: HttpStatus;
  readonly retrieved_at: string;
  readonly body: Json | null;
}

export type BacklogMatchStatus =
  | "matched"
  | "no_match_walk_complete"
  | "not_determined_walk_capped"
  | "not_attempted";

/** `E1-EP v1` — the frozen, minimized, authorized input of the baseline and any later model. */
export interface E1Pack {
  readonly schema_version: "e1-ep/1";
  readonly pack_id: string;
  readonly question: { readonly lang: Lang; readonly text: string };
  readonly scope: {
    readonly tenant_ref: string;
    readonly actor_role: ActorRole;
    readonly actor_store_scope: readonly string[];
    readonly sale_ref: string;
  };
  readonly assembled_at: string;
  readonly max_read_skew_ms: number;
  readonly reads: readonly E1Read[];
  readonly backlog_match: {
    readonly status: BacklogMatchStatus;
    readonly pages_walked: number;
    readonly page_size: number;
    readonly match_key: {
      readonly kind: "sale_post";
      readonly sourceSystem: string;
      readonly externalId: string;
      readonly store_id: string;
    } | null;
    readonly posting_status_id: string | null;
  };
  readonly untrusted_text: readonly { readonly ref: string; readonly text: string }[];
  readonly known_gaps: Readonly<Record<string, string>>;
}

/** One entry of the pack builder's route log: what S3 audits. */
export interface ReadLogEntry {
  readonly method: string;
  readonly op: string;
  readonly route: string;
}

/** The world the builder reads from: contract-conformant bodies per read. */
export interface RawRead {
  readonly status: HttpStatus;
  readonly body: Json | null;
}
export interface World {
  readonly r1: RawRead;
  readonly r2: RawRead;
  readonly r3: RawRead;
  readonly r4: readonly RawRead[];
}

/** Compact description of one synthetic sale; `buildWorld` expands it. */
export interface Scenario {
  readonly n: number;
  readonly sync: SyncStatus;
  readonly erp: ErpState;
  readonly store?: "A1" | "A2";
  readonly voided?: boolean;
  readonly reversal?: ErpState;
  readonly returns?: boolean;
  readonly repairResolved?: boolean;
  readonly reasonCode?: string;
  readonly retryCount?: number;
  /** Posting-backlog behaviour for a `failed` sale. */
  readonly backlog?: "match" | "capped" | "none";
  readonly backlogClass?: string | null;
  readonly collision?: boolean;
  readonly docRef?: string;
  readonly lineName?: string;
  readonly occurredAt?: string;
  readonly businessDate?: string;
  readonly status?: Partial<Record<"r1" | "r2" | "r3" | "r4", HttpStatus>>;
  readonly summaryStoreRef?: string;
  readonly summarySyncStatus?: SyncStatus;
  readonly crossTenant?: boolean;
}

/** Hand-transcribed gold label (RT-647 §6.2). Never computed from the baseline. */
export interface GoldLabel {
  readonly class: E1Class;
  readonly processing: string;
  readonly erp_sale: string;
  readonly erp_reversal: string;
  readonly backlog_class: string;
  readonly boundary: E1Boundary;
  readonly open_unknowns: readonly string[];
  readonly runbooks: readonly string[];
  /** processing / erp_sale / erp_reversal rule ids, or one gate rule id. */
  readonly rules: string;
  /** Claim template ids, in order. */
  readonly templates: readonly string[];
}

export interface E1Case {
  readonly id: string;
  readonly scenario: Scenario;
  readonly actor: ActorRole;
  /** Stores the operator may see; the sale's store is requested from the gateway. */
  readonly scopeStores: "all" | readonly ("A1" | "A2")[];
  readonly question: { readonly en: string; readonly ar: string };
  readonly gold: GoldLabel;
  readonly tags: readonly string[];
  readonly gates: readonly string[];
  /** Clean twin of an adversarial case (S6 twin-diff): overrides applied to `scenario`. */
  readonly twin?: Partial<Scenario>;
}
