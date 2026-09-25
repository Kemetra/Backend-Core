/**
 * ErpnextPostingController — 015-US1-FEED (T031).
 *
 * Implements `connectorPullPostings` from
 * `packages/contracts/openapi/erpnext-connector/posting-feed.yaml`:
 *   GET /api/connector/v1/erpnext/postings → a cursor-ordered page of pending
 *   posting work-items for the connector principal's tenant.
 *
 * Auth / context: `@UseGuards(ConnectorAuthGuard)` authenticates the opaque,
 * revocable MACHINE connector bearer (012 `connectorBearer`) and requires the
 * `connector` token scope. The tenant comes from the token principal ONLY
 * (`principal.tenantId`), never from the query/body (§XII). A connector token
 * with no tenant binding is a non-disclosing 401.
 *
 * READ-ONLY for the pull: NO status mutation at pull time (eligibility resolved
 * at row creation in the worker consumer) — re-pulling the same `since` cursor
 * yields the same logical set (012 idempotent replay). The outcome ACK
 * (`connectorAckOutcome`) lands in 015-US2-ACK.
 *
 * Audit: `@Auditable("erpnext.postings.pulled")` is passive metadata read by the
 * global AuditEmitterInterceptor.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
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
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  OutcomeAckBodySchema,
  type OutcomeAckBody,
} from "./dto/outcome-ack.dto";
import {
  PullPostingsQuerySchema,
  type PullPostingsQuery,
} from "./dto/pull-postings-query.dto";
import {
  AckConflictError,
  AckNotFoundError,
  ErpnextPostingService,
  type RecordedOutcome,
} from "./erpnext-posting.service";
import type { PostingWorkItem } from "./posting-work-item.projection";

/** The 012 PostingFeedPage wire envelope (snake_case per the contract). */
interface PostingFeedPageResponse {
  readonly items: readonly PostingWorkItem[];
  readonly cursor: string;
  readonly next_page_token: string | null;
}

@Controller("api/connector/v1/erpnext")
@UseGuards(ConnectorAuthGuard)
export class ErpnextPostingController {
  constructor(private readonly service: ErpnextPostingService) {}

  @Get("postings")
  @Auditable("erpnext.postings.pulled")
  async pullPostings(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(PullPostingsQuerySchema))
    query: PullPostingsQuery,
  ): Promise<PostingFeedPageResponse> {
    const principal = req.principal;
    // ConnectorAuthGuard guarantees a connector token principal; a token with no
    // tenant binding cannot scope the feed → non-disclosing 401.
    if (!principal || principal.kind !== "token" || principal.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.service.pullPostings({
      tenantId: principal.tenantId,
      since:
        query.since !== null && query.since !== undefined
          ? BigInt(query.since)
          : null,
      limit: query.limit ?? 100,
    });

    // The 012 `cursor` is required + minLength 1. On an empty page (no pending
    // rows), echo the caller's `since` so the connector can re-poll from the
    // same point; if there was no `since` either, emit "0" (the from-start
    // sentinel — every real sequence is >= 1).
    const cursor = result.cursor ?? query.since ?? "0";

    return {
      items: result.items,
      cursor,
      next_page_token: result.nextPageToken,
    };
  }

  /**
   * `connectorAckOutcome` — POST /…/{workItemRef}/outcome.
   *
   * Records the connector's posting outcome on `erpnext_posting_status` (never
   * the 008 sale fact, §IX). `@Idempotent("required")` enforces the HTTP
   * `Idempotency-Key` (012 x-idempotency: required) — same-key replay → 200; the
   * SERVICE additionally provides O-3 echo for a FRESH key re-acking an
   * already-terminal row. A first-time record returns 201; a service-level echo
   * returns 200 with `Idempotent-Replayed: true`. A cross-tenant/foreign ref →
   * non-disclosing 404 `not_found`; a contradicting re-ack → 409.
   */
  @Post("postings/:workItemRef/outcome")
  @Idempotent("required")
  @Auditable("erpnext.posting.outcome.recorded")
  @HttpCode(201)
  async ackOutcome(
    @Req() req: AuthedRequest,
    @Param("workItemRef", new ParseUUIDPipe())
    workItemRef: string,
    @Body(new ZodValidationPipe(OutcomeAckBodySchema)) body: OutcomeAckBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecordedOutcome> {
    const principal = req.principal;
    if (
      !principal ||
      principal.kind !== "token" ||
      principal.tenantId === null
    ) {
      throw new UnauthorizedException("Unauthorized");
    }

    try {
      const result = await this.service.ackOutcome({
        tenantId: principal.tenantId,
        workItemRef,
        outcome: body.outcome,
        ...(body.documentRef ? { documentRef: body.documentRef } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      });
      if (result.replayed) {
        // Service-level O-3 echo (fresh key, already-terminal row): the HTTP
        // interceptor won't set the header on a fresh key, so set it here + 200.
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200);
      }
      return result.outcome;
    } catch (err) {
      if (err instanceof AckNotFoundError) {
        throw new NotFoundException({
          code: "not_found",
          message: "Work item not found.",
        });
      }
      if (err instanceof AckConflictError) {
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "This work item was already resolved with a different outcome.",
        });
      }
      throw err;
    }
  }
}
