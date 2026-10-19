/**
 * RT-649 — fixture for the console sales summary spec.
 *
 * Builds on the RT-562 console sales fixture (`console-sales-fixture.ts`:
 * STORE_A_X in `Africa/Cairo` with its October sales, voids, returns and
 * postings; STORE_A_Y, S_DELETED, tenant B; every member and session) and
 * adds the facts that carry no stored business date:
 *
 *   - The 008 seed's legacy refunds are moved to a fixed instant
 *     (2026-05-01T10:00Z), so no figure depends on the clock of the run.
 *   - STORE_A_X legacy refunds and shift closes either side of the Cairo
 *     midnight between 2026-10-04 and 2026-10-05 (20:30Z is 10-04 and 22:30Z
 *     is 10-05 at either UTC+2 or UTC+3, so the Egyptian DST rule of the
 *     server's tz database does not matter).
 *   - STORE_A_Y switches to `America/New_York` AFTER its sales were seeded
 *     (a stored sale business date is never recomputed), with closes around
 *     both 2026 DST changes: 03-08 (a 23-hour day) and 11-01 (a 25-hour day).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0649`
 * mnemonic (hex only).
 */
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, TENANT_A } from "../../catalog/__support__/isolation-harness";
import { seedClose, type SeedClose } from "../../shift-closes/__support__/shift-close-fixture";
import { CASHIER, DEVICE_X, seedConsoleSalesFixture, X_OCT31 } from "./console-sales-fixture";

const id = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;

export const DEVICE_Y = id("649f01");

export const REFUND_X_OCT04 = id("649a01");
export const REFUND_X_OCT05 = id("649a02");

export const CLOSE_X_OCT04 = id("649b01");
export const CLOSE_X_OCT05 = id("649b02");

/** STORE_A_Y (America/New_York) closes and the local date each must land on. */
export const Y_DST_CLOSES: ReadonlyArray<{ readonly shiftId: string; readonly closedAt: string; readonly localDate: string }> = [
  // Spring forward, 2026-03-08 (EST -05 → EDT -04): a 23-hour day.
  { shiftId: id("649c01"), closedAt: "2026-03-08T04:30:00Z", localDate: "2026-03-07" },
  { shiftId: id("649c02"), closedAt: "2026-03-08T05:30:00Z", localDate: "2026-03-08" },
  { shiftId: id("649c03"), closedAt: "2026-03-09T03:30:00Z", localDate: "2026-03-08" },
  { shiftId: id("649c04"), closedAt: "2026-03-09T04:30:00Z", localDate: "2026-03-09" },
  // Fall back, 2026-11-01 (EDT -04 → EST -05): a 25-hour day.
  { shiftId: id("649c05"), closedAt: "2026-10-31T03:30:00Z", localDate: "2026-10-30" },
  { shiftId: id("649c06"), closedAt: "2026-11-01T04:30:00Z", localDate: "2026-11-01" },
  { shiftId: id("649c07"), closedAt: "2026-11-02T04:30:00Z", localDate: "2026-11-01" },
  { shiftId: id("649c08"), closedAt: "2026-11-02T05:30:00Z", localDate: "2026-11-02" },
];

/** opening 500.00, cash sales 100.00; `counted` sets the variance. */
function amounts(counted: number): SeedClose["amounts"] {
  return { opening: 50_000, sales: 10_000, refunds: 0, payIn: 0, payOut: 0, counted };
}

async function seedRefund(env: PgTestEnv, refundId: string, refundedAt: string): Promise<void> {
  await env.admin.query(
    `INSERT INTO sale_refunds
       (id, sale_id, tenant_id, store_id, refunded_at, pos_refund_amount, currency_code,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, $5::timestamptz, 2.0000, 'EGP', 'rt649-seed', $6, $7, $8)`,
    [refundId, X_OCT31, TENANT_A, STORE_A_X, refundedAt, `rt649-${refundId}`, "0".repeat(64), CASHIER],
  );
}

export async function seedConsoleSalesSummaryFixture(env: PgTestEnv): Promise<void> {
  await seedConsoleSalesFixture(env);
  await env.admin.query(`UPDATE sale_refunds SET refunded_at = '2026-05-01T10:00:00Z'`);

  await seedRefund(env, REFUND_X_OCT04, "2026-10-04T20:30:00Z");
  await seedRefund(env, REFUND_X_OCT05, "2026-10-04T22:30:00Z");

  const scopeX = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: DEVICE_X };
  // Forced, +12.50: Cairo 2026-10-04 late evening.
  await seedClose(env.app, {
    shiftId: CLOSE_X_OCT04,
    scope: scopeX,
    closedAt: "2026-10-04T20:30:00Z",
    amounts: amounts(61_250),
    closeKind: "forced",
    closingUserId: CASHIER,
  });
  // Normal, no variance: just after the Cairo midnight, 2026-10-05.
  await seedClose(env.app, {
    shiftId: CLOSE_X_OCT05,
    scope: scopeX,
    closedAt: "2026-10-04T22:30:00Z",
    amounts: amounts(60_000),
    closingUserId: CASHIER,
  });

  await env.admin.query(`UPDATE stores SET timezone = 'America/New_York' WHERE id = $1`, [STORE_A_Y]);
  await env.admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash, label) VALUES ($1, $2, $3, $4, 'till-y')`,
    [DEVICE_Y, TENANT_A, STORE_A_Y, "1".repeat(64)],
  );
  const scopeY = { tenantId: TENANT_A, storeId: STORE_A_Y, deviceId: DEVICE_Y };
  for (const close of Y_DST_CLOSES) {
    await seedClose(env.app, {
      shiftId: close.shiftId,
      scope: scopeY,
      closedAt: close.closedAt,
      amounts: amounts(60_000),
      closingUserId: CASHIER,
    });
  }
}
