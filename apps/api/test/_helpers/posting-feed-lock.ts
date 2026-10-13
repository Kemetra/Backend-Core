/**
 * RT-456 test helper: proves a write path takes the tenant's posting-feed
 * sequence lock (`lockPostingFeedSequence`) before it can assign a sequence.
 *
 * Another session holds the lock; `run()` must not settle while it is held and
 * must settle (resolve or reject) once it is released.
 */
import type { Pool } from "pg";
import { lockPostingFeedSequence } from "@data-pulse-2/db";

const HOLD_MS = 750;

export async function expectWaitsForPostingFeedLock(
  admin: Pool,
  tenantId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const holder = await admin.connect();
  let settled = false;
  let pending: Promise<void> | null = null;
  try {
    await holder.query("BEGIN");
    await lockPostingFeedSequence(holder, tenantId);
    const markSettled = (): void => {
      settled = true;
    };
    pending = run().then(markSettled, markSettled);
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    expect(settled).toBe(false);
  } finally {
    await holder.query("COMMIT");
    holder.release();
  }
  await pending;
  expect(settled).toBe(true);
}

