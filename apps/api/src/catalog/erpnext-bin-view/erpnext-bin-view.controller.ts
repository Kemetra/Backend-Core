/**
 * ErpnextBinViewController — 019-T040.
 *
 * Implements the two operations of
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml`:
 *   GET  /api/connector/v1/erpnext/bin-view-requests             → binViewPullRequests
 *   POST /api/connector/v1/erpnext/bin-view-requests/{requestRef}/snapshot
 *                                                                → binViewReportSnapshot
 *
 * Auth / context: `@UseGuards(ConnectorAuthGuard)` authenticates the opaque,
 * revocable MACHINE connector bearer (012 `connectorBearer`) + requires the
 * `connector` token scope (NOT a human session, NOT a POS device). Tenant comes
 * from the token principal ONLY (§XII), never query/body.
 *
 * The pull is READ-ONLY (idempotent on `since`). The report is
 * `@Idempotent("required")` (012 x-idempotency: required) — same-key replay → 200;
 * the SERVICE additionally provides O-3 echo (a fresh key re-reporting an
 * already-recorded request) → 200 `Idempotent-Replayed: true`; a first record →
 * 201. A cross-tenant/foreign `requestRef` → non-disclosing 404; a contradicting
 * re-report → 409 `idempotency_key_conflict`.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../../audit/auditable.decorator";
import type { AuthedRequest } from "../../auth/auth.guard";
import { ConnectorAuthGuard } from "../../auth/connector-auth.guard";
import { ConnectorEnvironmentGuard } from "../../auth/connector-environment.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  PullRequestsQuerySchema,
  type PullRequestsQuery,
} from "./dto/pull-requests-query.dto";
import {
  SnapshotReportBodySchema,
  type SnapshotReportBody,
} from "./dto/snapshot-report.dto";
import {
  BinViewConflictError,
  BinViewNotFoundError,
  ErpnextBinViewService,
  type BinViewRequest,
  type RecordedBinView,
} from "./erpnext-bin-view.service";

/** The 019 BinViewPage wire envelope (snake_case per the contract). */
interface BinViewPageResponse {
  readonly items: readonly BinViewRequest[];
  readonly cursor: string;
  readonly next_page_token: string | null;
}

@Controller("api/connector/v1/erpnext")
@UseGuards(ConnectorAuthGuard, ConnectorEnvironmentGuard)
export class ErpnextBinViewController {
  constructor(private readonly service: ErpnextBinViewService) {}

  @Get("bin-view-requests")
  @Auditable("erpnext.bin_view.pulled")
  async pullRequests(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(PullRequestsQuerySchema))
    query: PullRequestsQuery,
  ): Promise<BinViewPageResponse> {
    const principal = req.principal;
    if (!principal || principal.kind !== "token" || principal.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.service.pullRequests({
      tenantId: principal.tenantId,
      since: query.since ?? null,
      limit: query.limit ?? 100,
    });

    // The 019 `cursor` is required + minLength 1. On an empty page, echo the
    // caller's `since` so the connector can re-poll; if none, emit the from-start
    // sentinel UUID (no real run id equals it).
    const cursor = result.cursor ?? query.since ?? "00000000-0000-0000-0000-000000000000";

    return {
      items: result.items,
      cursor,
      next_page_token: result.nextPageToken,
    };
  }

  @Post("bin-view-requests/:requestRef/snapshot")
  @Idempotent("required")
  @Auditable("erpnext.bin_view.reported")
  @HttpCode(201)
  async reportSnapshot(
    @Req() req: AuthedRequest,
    @Param("requestRef", new ParseUUIDPipe()) requestRef: string,
    @Body(new ZodValidationPipe(SnapshotReportBodySchema)) body: SnapshotReportBody,
    @Headers("idempotency-key") idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecordedBinView> {
    const principal = req.principal;
    if (!principal || principal.kind !== "token" || principal.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    try {
      const result = await this.service.reportSnapshot({
        tenantId: principal.tenantId,
        requestRef,
        body,
        idempotencyKey,
      });
      if (result.replayed) {
        // Service-level O-3 echo (fresh key, already-recorded request): set the
        // header + 200 (the HTTP interceptor won't, since the key is fresh).
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200);
      }
      return result.view;
    } catch (err) {
      if (err instanceof BinViewNotFoundError) {
        throw new NotFoundException({
          code: "not_found",
          message: "Bin-view request not found.",
        });
      }
      if (err instanceof BinViewConflictError) {
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "This bin-view request was already reported with a different snapshot.",
        });
      }
      throw err;
    }
  }
}
