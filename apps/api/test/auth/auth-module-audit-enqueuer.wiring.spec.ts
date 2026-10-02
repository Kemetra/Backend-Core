/**
 * RT-124 — AuthModule's AUDIT_JOB_ENQUEUER takes the same outbox-aware path
 * as the request graph, instead of always the direct BullMQ producer, so
 * sign-in audits are durable when the outbox path is on.
 */
import "reflect-metadata";

import type { FactoryProvider } from "@nestjs/common";
import type { Pool } from "pg";

import { AUDIT_JOB_ENQUEUER } from "../../src/audit/audit-job.enqueuer";
import { OutboxAuditEnqueuer } from "../../src/audit/outbox-audit-enqueuer";
import { PG_POOL } from "../../src/auth/database-pools";
import { AuthModule } from "../../src/auth/auth.module";

function enqueuerProvider(): FactoryProvider {
  const providers = Reflect.getMetadata("providers", AuthModule) as unknown[];
  const match = providers.find(
    (p): p is FactoryProvider =>
      typeof p === "object" && p !== null && (p as FactoryProvider).provide === AUDIT_JOB_ENQUEUER,
  );
  if (!match) throw new Error("AuthModule does not provide AUDIT_JOB_ENQUEUER");
  return match;
}

describe("AuthModule AUDIT_JOB_ENQUEUER wiring (RT-124)", () => {
  const original = process.env["OUTBOX_AUDIT_ENABLED"];

  afterEach(() => {
    if (original === undefined) delete process.env["OUTBOX_AUDIT_ENABLED"];
    else process.env["OUTBOX_AUDIT_ENABLED"] = original;
  });

  it("is a factory over PG_POOL", () => {
    expect(enqueuerProvider().inject).toEqual([PG_POOL]);
  });

  it("returns the outbox enqueuer when the outbox path is on and a pool exists", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    const enqueuer = enqueuerProvider().useFactory({} as Pool);
    expect(enqueuer).toBeInstanceOf(OutboxAuditEnqueuer);
  });

  it("does not return the outbox enqueuer when the outbox path is off", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "0";
    const enqueuer = enqueuerProvider().useFactory({} as Pool);
    expect(enqueuer).not.toBeInstanceOf(OutboxAuditEnqueuer);
  });
});
