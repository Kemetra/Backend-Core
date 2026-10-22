/**
 * PlatformAuditService — `listPlatformAuditEvents` (RT-431).
 *
 * Same paging as `AuditService.list` (`limit + 1`, `toPage`), over the
 * platform-scoped rows only (`PlatformAuditRepository.listPlatformPage`).
 * The projection sets `tenant_id` null and masks `actor_label` (decision
 * D5); `actor_user_id` is returned as stored. Authorization is the
 * controller's guards; nothing here is logged or audited.
 */
import { Inject, Injectable } from "@nestjs/common";

import { kindOf, type AuditActionKind } from "./audit-action-kinds";
import type { AuditCursor } from "./audit.query.schema";
import {
  PLATFORM_AUDIT_REPOSITORY,
  type PlatformAuditEventRecord,
  type PlatformAuditRepository,
} from "./audit.repository";
import type { ListPlatformAuditEventsResponse, PlatformAuditEventDto } from "./audit.dto";
import { toPage } from "./audit.service";
import { maskActorLabel } from "./platform-audit.mask";

export interface ListPlatformAuditEventsInput {
  readonly action?: string | undefined;
  readonly kind?: AuditActionKind | undefined;
  readonly actor_user_id?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor?: AuditCursor | undefined;
  readonly limit: number;
}

@Injectable()
export class PlatformAuditService {
  constructor(
    @Inject(PLATFORM_AUDIT_REPOSITORY)
    private readonly repo: PlatformAuditRepository,
  ) {}

  async list(input: ListPlatformAuditEventsInput): Promise<ListPlatformAuditEventsResponse> {
    const rows = await this.repo.listPlatformPage({
      action: input.action,
      kind: input.kind,
      actorUserId: input.actor_user_id,
      from: input.from,
      to: input.to,
      cursor: input.cursor ?? null,
      limit: input.limit + 1,
    });
    return toPage(rows, input.limit, toPlatformDto);
  }
}

function toPlatformDto(row: PlatformAuditEventRecord): PlatformAuditEventDto {
  return {
    id: row.id,
    occurred_at: row.occurredAt.toISOString(),
    actor_user_id: row.actorUserId,
    actor_label: maskActorLabel(row.actorLabel),
    tenant_id: null,
    store_id: row.storeId,
    action: row.action,
    kind: kindOf(row.action),
    target_type: row.targetType,
    target_id: row.targetId,
    request_id: row.requestId,
    metadata: row.metadata ?? {},
  };
}
