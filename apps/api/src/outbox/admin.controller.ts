/**
 * OutboxAdminController — `GET /api/v1/admin/outbox/dead-letters` and
 * `GET /api/v1/admin/outbox/dead-letters/{eventId}` (T591, slice 1C-C1).
 *
 * Conforms to `packages/contracts/openapi/outbox.openapi.yaml`
 * (operationIds `listOutboxDeadLetters` + `getOutboxDeadLetter`).
 *
 * Role / guard strategy — slice 1C-C1 only
 * ----------------------------------------
 * Uses the existing `@PlatformAdminOnly()` decorator as the operator
 * gate. The dedicated `platform:operator` role proposed in
 * `docs/outbox/dead-letter-triage.md` §5.1 is deferred to a separate
 * role-foundation slice — adding it now would require editing the
 * `RoleCode` union AND seeding a new role in the `roles` table (a
 * schema/migration change, which is explicitly forbidden by this
 * slice's hard constraints).
 *
 * Why this is safe: `@PlatformAdminOnly()` is a strictly tighter gate
 * than "platform operator" — every platform operator the future role
 * scheme grants will also be a platform admin, so no operator who
 * currently has access loses it when the dedicated role lands.
 * RolesGuard returns 403 (not 404) on deny — platform-admin status is
 * self-knowable via `GET /context/me`, so the response leaks nothing.
 *
 * Why no TenantContextGuard
 * -------------------------
 * The endpoint is platform-scoped (triage doc §5.4). The operator is
 * acting on the SaaS-wide surface, NOT on behalf of any tenant; the
 * repository runs queries under `runWithTenantContext({ tenantId: null,
 * isPlatformAdmin: true })`. Mounting TenantContextGuard here would
 * (incorrectly) require the operator to first activate a tenant.
 *
 * Why no `@Auditable` on these handlers
 * -------------------------------------
 * Read-only triage. Audit-of-triage-reads is deferred to the gated
 * action slice (replay/acknowledge) where the action itself emits an
 * audit event. List/detail are observability surfaces, not state
 * changes.
 *
 * Redaction posture
 * -----------------
 * The response NEVER contains `payload`, `last_error` (raw column), or
 * any field outside the strict allowlist in `docs/outbox/dead-letter-
 * triage.md` §4.1. `last_error_class` is sanitized at the repository
 * boundary (`sanitizeLastErrorClass`) — the service layer trusts the
 * repository's contract.
 */
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from "@nestjs/common";

import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { PlatformAdminOnly } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

import {
  OutboxAdminListQuerySchema,
  type OutboxAdminListQueryParsed,
} from "./admin.query.schema";
import { OutboxAdminService } from "./admin.service";
import type {
  ListOutboxDeadLettersResponse,
  OutboxDeadLetterDto,
} from "./admin.dto";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

@Controller("api/v1/admin/outbox")
@UseGuards(DashboardAuthGuard, RolesGuard)
export class OutboxAdminController {
  constructor(
    @Inject(OutboxAdminService)
    private readonly service: OutboxAdminService,
  ) {}

  /**
   * List dead-lettered events, newest first. Filterable by event_type
   * and tenant_id; paginated via opaque base64url cursor.
   *
   * Returns `{ items: [], next_cursor: null }` on an empty page. The
   * `next_cursor` is non-null only when more rows are available.
   */
  @Get("dead-letters")
  @PlatformAdminOnly()
  // RT-619 (RT-574 D3): listOutboxDeadLetters.
  @ConsoleRateLimit("expensiveRead")
  async list(
    @Query(new ZodValidationPipe(OutboxAdminListQuerySchema))
    query: OutboxAdminListQueryParsed,
  ): Promise<ListOutboxDeadLettersResponse> {
    return this.service.list({
      eventType: query.event_type,
      tenantId: query.tenant_id,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * Detail for a single dead-lettered event. Returns 404 when:
   *   - the event_id does not exist, OR
   *   - the event_id exists but is not in `dead_lettered` state.
   *
   * Both cases are externally indistinguishable by design — the
   * endpoint contract is dead-letter triage, not generic event lookup.
   */
  @Get("dead-letters/:eventId")
  @PlatformAdminOnly()
  async get(
    @Param("eventId", new ParseUUIDPipe()) eventId: string,
  ): Promise<OutboxDeadLetterDto> {
    const row = await this.service.get(eventId);
    if (!row) {
      // Throw a plain string-payload NotFoundException so the
      // GlobalExceptionFilter maps it to the canonical envelope
      // `{ error: { code: "not_found", message, request_id } }`
      // documented in outbox.openapi.yaml. CodeRabbit review on
      // PR #240: constructing a custom `{ statusCode, error, message }`
      // body here would only be cosmetic (the filter discards every
      // field except `message`), but it created the impression of
      // controller/contract drift -- the inline body did not match
      // the documented Error schema even though the wire bytes did.
      throw new NotFoundException("Dead-letter event not found.");
    }
    return row;
  }
}
