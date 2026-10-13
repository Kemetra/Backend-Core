/**
 * RT-456 test helpers shared by the api and worker posting-feed specs.
 *
 * `servedAcrossConcurrentCommit` drives the feed-completeness scenario: one
 * writer draws a posting-feed sequence and is held open (uncommitted), a
 * second writer runs, the feed is pulled and its cursor persisted (as the
 * connector does), the first writer is released, and the feed is pulled again
 * from that cursor. It returns every row served across both pulls.
 */
import type { Pool } from "pg";

export interface ServedPostingRow {
  readonly id: string;
  readonly sourceRefId: string;
}

/**
 * A pool whose connections pause right after the first statement matching
 * `pausesAfter` until `release()` is called — holding that transaction open.
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

/** The connector's pull: the exact pullPostings predicate/order, as the app role under RLS. */
export async function pullPostingFeed(
  app: Pool,
  tenantId: string,
  since: string | null,
): Promise<{ rows: ServedPostingRow[]; cursor: string | null }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const r = await client.query<{ id: string; source_ref_id: string; sequence: string }>(
      `SELECT id, source_ref_id, sequence::text AS sequence
         FROM erpnext_posting_status
        WHERE status = 'pending'
          AND ($1::bigint IS NULL OR sequence > $1::bigint)
        ORDER BY erpnext_posting_status.sequence`,
      [since],
    );
    await client.query("COMMIT");
    const last = r.rows[r.rows.length - 1];
    return {
      rows: r.rows.map((row) => ({ id: row.id, sourceRefId: row.source_ref_id })),
      // An empty page echoes `since` (erpnext-posting.controller.ts).
      cursor: last ? last.sequence : since,
    };
  } finally {
    client.release();
  }
}

export async function servedAcrossConcurrentCommit(opts: {
  readonly app: Pool;
  readonly tenantId: string;
  /** Matches the statement that draws the held writer's sequence. */
  readonly pausesAfter: RegExp;
  readonly heldWriter: (pool: Pool) => Promise<unknown>;
  readonly otherWriter: (pool: Pool) => Promise<unknown>;
}): Promise<ServedPostingRow[]> {
  const start = (await pullPostingFeed(opts.app, opts.tenantId, null)).cursor;

  const held = pausingPool(opts.app, opts.pausesAfter);
  const first = opts.heldWriter(held.pool);
  await held.paused;

  // Without commit ordering the other writer commits a HIGHER sequence while
  // the held one is open; with it, it waits for the held writer to commit.
  const second = opts.otherWriter(opts.app);
  await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 1_000))]);

  const pulled = await pullPostingFeed(opts.app, opts.tenantId, start);
  held.release();
  await Promise.all([first, second]);
  const again = await pullPostingFeed(opts.app, opts.tenantId, pulled.cursor);
  return [...pulled.rows, ...again.rows];
}
