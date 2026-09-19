/**
 * SettlementController — 035 T030.
 *
 * Three routes from the ratified contract
 * (packages/contracts/openapi/settlement/settlement.yaml):
 *
 *   POST /api/v1/settlement/settlement-intent          posRecordSettlementIntent (POS)
 *   GET  /api/v1/settlement/receivables/{receivableRef} consoleGetReceivable     (Console)
 *   GET  /api/v1/settlement/receivables                 consoleListReceivables    (Console)
 *
 * AUTH split by surface (035 §8):
 *   - The POS intent route is guarded by `PosOperatorEnvelopeSaleGuard` (031
 *     D1+D2) — canonical envelope bearer + live operator re-verification. That
 *     guard populates `request.context` (tenant/store/actor from the server-side
 *     envelope binding, never the body) and runs WITHOUT TenantContextGuard.
 *     The route declares NO 404/403 (contract) — an unknown/cross-tenant payer
 *     OR sale is a deterministic 409 `conflict`.
 *   - The Console routes use the HUMAN `cookieAuth` stack
 *     (`DashboardAuthGuard` + `TenantContextGuard`) + per-route `RolesGuard` /
 *     `@Roles` (default deny → 404 non-disclosing). A valid-but-out-of-scope
 *     ref / filter is a non-disclosing 404 (§II/§XII, FR-022).
 *
 * `tenant_id` + store + actor are resolved server-side from `request.context`,
 * never the body/query (§XII; strict Zod DTOs reject smuggled fields → 400).
 * Every response is a `toReceivable` projection (no raw DB entity, §IV).
 * The intent route is `@Idempotent("required")` — replay-safety (FR-020/G5) is
 * accelerated by the interceptor and durably enforced in the service's
 * PostgreSQL transaction.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Auditable } from "../audit/auditable.decorator";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { PosWriteRateLimitBucket } from "../auth/pos-write-rate-limit.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import {
  ApplyPaymentRequestSchema,
  type ApplyPaymentRequestDto,
} from "./dto/apply-payment-request.dto";
import {
  ClaimCreateSchema,
  type ClaimCreateDto,
  RemittanceReconcileSchema,
  type RemittanceReconcileDto,
  type ClaimBody,
  type ReconciliationResultBody,
} from "./dto/claim-request.dto";
import { ClaimService } from "./claim.service";
import { toReceivable, type ReceivableBody } from "./dto/receivable.dto";
import {
  ReceivableListQuerySchema,
  type ReceivableListQuery,
} from "./dto/receivable-query.dto";
import {
  SettlementIntentCreateSchema,
  type SettlementIntentCreateDto,
} from "./dto/settlement-intent-request.dto";
import { ReceivableService } from "./receivable.service";

/** Canonical UUID shape — a receivableRef that fails this never hits the DB. */
const ReceivableRefSchema = z.string().uuid();

/** The page wire shape — { items, nextCursor } (contract `ReceivablePage`). */
interface ReceivablePageBody {
  readonly items: ReceivableBody[];
  readonly nextCursor: string | null;
}

/** The intent result wire shape (contract `SettlementIntentResult`). */
interface SettlementIntentResultBody {
  readonly saleRef: string;
  readonly receivables: ReceivableBody[];
}

@Controller()
export class SettlementController {
  constructor(
    private readonly service: ReceivableService,
    private readonly claims: ClaimService,
  ) {}

  // -------------------------------------------------------------------------
  // POS — settlement-intent capture (operator envelope; intent only)
  // -------------------------------------------------------------------------

  /**
   * POST — record settlement intent over a captured sale, opening the
   * receivable(s). Idempotent (interceptor). The sale is NOT mutated. An
   * unknown / cross-tenant payer or sale → 409 `conflict` (no 404 on this
   * surface).
   */
  @Post("api/v1/settlement/settlement-intent")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteSettlementIntent")
  @Idempotent("required")
  async recordIntent(
    @Req() request: TenantContextRequest,
    @Headers("idempotency-key") idempotencyKey: string,
    @Body(new ZodValidationPipe(SettlementIntentCreateSchema))
    body: SettlementIntentCreateDto,
  ): Promise<SettlementIntentResultBody> {
    const { tenantId, storeId, userId } = this.requirePosContext(request);
    const result = await this.service.openFromIntent({
      tenantId,
      storeId,
      operation: {
        idempotencyKey,
        actorUserId: userId,
        requestId: request.requestId ?? null,
      },
      saleRef: body.saleRef,
      payers: body.payers.map((p) => ({
        payerRef: p.payerRef,
        owedAmount: p.owedAmount,
        claimMetadata: p.claimMetadata ?? null,
      })),
    });
    if (result.kind === "idempotency_conflict") {
      throw new ConflictException({
        code: "idempotency_key_conflict",
        message:
          "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
      });
    }
    if (result.kind === "conflict") {
      // Unknown / cross-tenant payer OR sale — deterministic, side-effect-free.
      throw new ConflictException({
        code: "conflict",
        message: "The settlement intent references an unknown payer or sale.",
      });
    }
    return {
      saleRef: body.saleRef,
      receivables: result.rows.map(toReceivable),
    };
  }

  // -------------------------------------------------------------------------
  // Console — receivable read + list (cookie session)
  // -------------------------------------------------------------------------

  /** GET — one receivable's projection; out-of-scope ref → non-disclosing 404. */
  @Get("api/v1/settlement/receivables/:receivableRef")
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("settlement.receivable.read")
  async getReceivable(
    @Req() request: TenantContextRequest,
    @Param("receivableRef") receivableRef: string,
  ): Promise<ReceivableBody> {
    const tenantId = this.requireTenant(request);
    this.assertUuid(receivableRef, "receivableRef");
    const result = await this.service.getOne({ tenantId, receivableRef });
    if (result.kind === "not_found") {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    return toReceivable(result.row);
  }

  /** GET — the tenant's receivable queue, newest-first, keyset paginated. */
  @Get("api/v1/settlement/receivables")
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("settlement.receivable.listed")
  async listReceivables(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ReceivableListQuerySchema))
    query: ReceivableListQuery,
  ): Promise<ReceivablePageBody> {
    const tenantId = this.requireTenant(request);
    // Out-of-scope filter id → non-disclosing 404 (contract parameter prose).
    if (!(await this.service.storeInScope(tenantId, query.store_id))) {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    if (!(await this.service.payerRefInScope(tenantId, query.payer_ref))) {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    const page = await this.service.list({
      tenantId,
      cursor: query.cursor ?? null,
      limit: query.page_size ?? 50,
      ...(query.store_id ? { storeId: query.store_id } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.payer_ref ? { payerRef: query.payer_ref } : {}),
    });
    return { items: page.items.map(toReceivable), nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------
  // Console — cash application (7-C; DP-2-owned operational truth)
  // -------------------------------------------------------------------------

  /**
   * POST :receivableRef/apply-payment — apply a payment/cash against the
   * receivable. Version-guarded (stale version → 409 conflict); over-application
   * (amount > outstanding balance) → 409 conflict (no truncation); an
   * out-of-scope / absent ref → non-disclosing 404. Idempotent (interceptor).
   * The ERPNext Payment Entry is NOT posted here (7-C; connector-owned).
   */
  @Post("api/v1/settlement/receivables/:receivableRef/apply-payment")
  @HttpCode(HttpStatus.OK)
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  async applyPayment(
    @Req() request: TenantContextRequest,
    @Param("receivableRef") receivableRef: string,
    @Body(new ZodValidationPipe(ApplyPaymentRequestSchema))
    body: ApplyPaymentRequestDto,
  ): Promise<ReceivableBody> {
    const { tenantId, userId } = this.requireMutationContext(request);
    this.assertUuid(receivableRef, "receivableRef");
    const result = await this.service.applyPayment({
      tenantId,
      actorUserId: userId,
      requestId: request.requestId ?? null,
      receivableRef,
      amount: body.amount,
      version: body.version,
      note: body.note ?? null,
    });
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "Stale version, the receivable is already terminal, or the amount " +
          "exceeds the outstanding balance (§III).",
      });
    }
    if (result.kind === "not_found") {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    return toReceivable(result.row);
  }

  // -------------------------------------------------------------------------
  // Console — claims + remittance reconciliation (FR-014)
  // -------------------------------------------------------------------------

  /**
   * POST /claims — submit receivable(s) to a third-party payer as a claim,
   * transitioning them → 'claimed'. Unknown payer → non-disclosing 404; an
   * unknown / non-claimable / mixed-store receivable batch → 409 conflict.
   */
  @Post("api/v1/settlement/claims")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  async submitClaim(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(ClaimCreateSchema))
    body: ClaimCreateDto,
  ): Promise<ClaimBody> {
    const { tenantId, userId } = this.requireMutationContext(request);
    const result = await this.claims.submitClaim({
      tenantId,
      actorUserId: userId,
      requestId: request.requestId ?? null,
      payerRef: body.payerRef,
      receivableRefs: body.receivableRefs,
    });
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "One or more receivables are unknown, not claimable (must be open " +
          "or partially applied), or span multiple stores.",
      });
    }
    if (result.kind === "not_found") {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    return result.claim;
  }

  /**
   * POST /claims/:claimRef/reconcile-remittance — match a remittance against the
   * claim, recording variance. A claim already reconciled → 409 conflict; an
   * absent / out-of-scope claim → non-disclosing 404. Idempotent (interceptor).
   */
  @Post("api/v1/settlement/claims/:claimRef/reconcile-remittance")
  @HttpCode(HttpStatus.OK)
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  async reconcileRemittance(
    @Req() request: TenantContextRequest,
    @Param("claimRef") claimRef: string,
    @Body(new ZodValidationPipe(RemittanceReconcileSchema))
    body: RemittanceReconcileDto,
  ): Promise<ReconciliationResultBody> {
    const { tenantId, userId } = this.requireMutationContext(request);
    this.assertUuid(claimRef, "claimRef");
    const result = await this.claims.reconcileRemittance({
      tenantId,
      actorUserId: userId,
      requestId: request.requestId ?? null,
      claimRef,
      remittedAmount: body.remittedAmount,
      remittanceRef: body.remittanceRef ?? null,
    });
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message: "The claim is not in a reconcilable state (already reconciled).",
      });
    }
    if (result.kind === "not_found") {
      throw new NotFoundException({ code: "not_found", message: "Not found." });
    }
    return result.result;
  }

  // -------------------------------------------------------------------------
  // Context helpers
  // -------------------------------------------------------------------------

  /** Tenant + store from the POS operator-envelope context. */
  private requirePosContext(request: TenantContextRequest): {
    tenantId: string;
    storeId: string;
    userId: string;
  } {
    const ctx = request.context;
    if (!ctx || ctx.userId === null || ctx.tenantId === null || ctx.storeId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, storeId: ctx.storeId, userId: ctx.userId };
  }

  /** Tenant from the dashboard session context. */
  private requireTenant(request: TenantContextRequest): string {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx.tenantId;
  }

  /** Actor + tenant required by integrity-sensitive transactional audit writes. */
  private requireMutationContext(request: TenantContextRequest): {
    tenantId: string;
    userId: string;
  } {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  }

  /**
   * Reject a syntactically MALFORMED ref with 400 BEFORE any DB hit (a
   * request-shape error, discloses nothing). A VALID-but-out-of-scope ref is
   * left to the service's non-disclosing 404 — the two cases are distinct.
   */
  private assertUuid(value: string, field: string): void {
    if (!ReceivableRefSchema.safeParse(value).success) {
      throw new BadRequestException({
        code: "validation_error",
        message: `${field} must be a valid UUID.`,
      });
    }
  }
}
