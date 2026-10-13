/**
 * RT-456 test helper: proves a write path takes the tenant's posting-feed
 * sequence lock (`lockPostingFeedSequence`) before it can assign a sequence.
 *
 * Another session holds the lock; `run()` must not settle while it is held and
 * must settle (resolve or reject) once it is released.
 */
import type { Pool } from "pg";
import { POSTING_FEED_LOCK_NAMESPACE } from "@data-pulse-2/db";

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
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`,
      [POSTING_FEED_LOCK_NAMESPACE, tenantId],
    );
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

/**
 * A pool whose connections pause right after the first statement matching
 * `pausesAfter` (e.g. the one that draws a posting-feed sequence) until
 * `release()` is called — holding that transaction open, uncommitted.
 */
export function pausingPool(
  base: Pool,
  pausesAfter: RegExp,
): { pool: Pool; paused: Promise<void>; release: () => void } {
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => (markPaused = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pool = {
    connect: async () => {
      const client = await base.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      const releaseClient = client.release.bind(client);
      const patched = client as unknown as { query: unknown; release: unknown };
      patched.query = async (...args: unknown[]) => {
        const result = await query(...args);
        if (typeof args[0] === "string" && pausesAfter.test(args[0])) {
          markPaused();
          await gate;
        }
        return result;
      };
      patched.release = (err?: Error | boolean) => {
        patched.query = query;
        return releaseClient(err);
      };
      return client;
    },
  } as unknown as Pool;
  return { pool, paused, release };
}
