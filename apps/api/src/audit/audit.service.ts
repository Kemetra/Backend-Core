/**
 * AuditService — business logic for `GET /api/v1/audit/events` (T235).
 *
 * Responsibilities:
 *   1. Translate parsed query params (`AuditQueryParsed` shape, with
 *      decoded `cursor` and Date objects) into the repository's
 *      `ListPageInput` shape (camelCase `actorUserId` / `storeId`).
 *   2. Ask the repository for `limit + 1` rows so end-of-page is
 *      detectable in one round-trip.
 *   3. Trim the extra row, build `next_cursor` from the LAST kept row
 *      when the page was full, project records to the OpenAPI snake_case
 *      `AuditEventDto` shape.
 *
 * What this service does NOT do
 * -----------------------------
 *   - Authorize the request — `AuthGuard` + `TenantContextGuard` +
 *     `RolesGuard` on the controller handle that.
 *   - Read `audit_events` directly — every DB touch goes through
 *     `AuditRepository.listPage` which itself opens a
 *     `runWithTenantContext` transaction with the tenant + admin GUCs.
 *   - Log audit metadata content (Constitution P14). Service emits no
 *     log lines that include `metadata.*` values.
 */
import { Inject, Injectable } from "@nestjs/common";

import { kindOf, type AuditActionKind } from "./audit-action-kinds";
import { encodeCursor, type AuditCursor } from "./audit.query.schema";
import {
  AUDIT_REPOSITORY,
  type AuditEventRecord,
  type AuditRepository,
} from "./audit.repository";
import {
  type AuditEventDto,
  type ListAuditEventsResponse,
} from "./audit.dto";

/** Service-level input — output of the Zod schema plus the resolved tenant/admin context. */
export interface ListAuditEventsInput {
  readonly tenantId: string;
  readonly isPlatformAdmin: boolean;
  readonly action?: string | undefined;
  readonly kind?: AuditActionKind | undefined;
  readonly actor_user_id?: string | undefined;
  readonly store_id?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor?: AuditCursor | undefined;
  readonly limit: number;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_REPOSITORY)
    private readonly repo: AuditRepository,
  ) {}

  async list(input: ListAuditEventsInput): Promise<ListAuditEventsResponse> {
    // Ask for one extra row so we can detect end-of-page cheaply.
    // Cap at 201 so the repo never receives an over-budget limit.
    const fetchLimit = input.limit + 1;

    const rows = await this.repo.listPage({
      tenantId: input.tenantId,
      isPlatformAdmin: input.isPlatformAdmin,
      action: input.action,
      kind: input.kind,
      actorUserId: input.actor_user_id,
      storeId: input.store_id,
      from: input.from,
      to: input.to,
      cursor: input.cursor ?? null,
      limit: fetchLimit,
    });

    const hasMore = rows.length > input.limit;
    const kept = hasMore ? rows.slice(0, input.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && kept.length > 0) {
      const last = kept.at(-1)!;
      nextCursor = encodeCursor(last.occurredAt, last.id);
    }

    return {
      items: kept.map(toDto),
      next_cursor: nextCursor,
    };
  }
}

/** Project a repository record to the wire shape, with `kind` derived from `action`. */
function toDto(row: AuditEventRecord): AuditEventDto {
  return {
    id: row.id,
    occurred_at: row.occurredAt.toISOString(),
    actor_user_id: row.actorUserId,
    actor_label: row.actorLabel,
    tenant_id: row.tenantId,
    store_id: row.storeId,
    action: row.action,
    kind: kindOf(row.action),
    target_type: row.targetType,
    target_id: row.targetId,
    request_id: row.requestId,
    metadata: row.metadata ?? {},
  };
}
