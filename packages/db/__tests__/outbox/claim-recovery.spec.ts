import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../_helpers/postgres-container';
import {
  claimBatch,
  heartbeatClaim,
  markDelivered,
  reclaimStaleClaims,
} from '../../src/outbox/repository';

const TENANT = '0ca00000-0000-7000-8000-000000000101';
const EVENT = '0cc00000-0000-4000-8000-000000000101';
let env: PgTestEnv;

beforeAll(async () => {
  env = await startPgEnv();
  await applyAllUpAndCreateAppRole(env);
  await env.admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'claim-recovery', 'Claim Recovery')`, [TENANT]);
  await env.admin.query(
    `INSERT INTO outbox_events (event_id, tenant_id, event_type, payload)
     VALUES ($1, $2, 'audit.event.created', '{}'::jsonb)`,
    [EVENT, TENANT],
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

it('reclaims a crashed worker claim on the next sweep and fences its late completion', async () => {
  const first = (await claimBatch(env.admin, 1))[0]!;
  expect(first.event_id).toBe(EVENT);
  await env.admin.query(`UPDATE outbox_events SET claimed_at=now() - interval '2 minutes' WHERE event_id=$1`, [EVENT]);

  expect(await reclaimStaleClaims(env.admin, 60_000)).toBe(1);
  const second = (await claimBatch(env.admin, 1))[0]!;
  expect(second.event_id).toBe(EVENT);
  expect(second.attempts).toBe(first.attempts + 1);
  await expect(markDelivered(env.admin, EVENT, first.attempts)).rejects.toThrow();
  await markDelivered(env.admin, EVENT, second.attempts);
  const row = await env.admin.query<{ delivery_state: string }>(
    `SELECT delivery_state FROM outbox_events WHERE event_id=$1`, [EVENT],
  );
  expect(row.rows[0]?.delivery_state).toBe('delivered');
});

it('keeps an active claim out of the reclaim sweep while its heartbeat is current', async () => {
  await env.admin.query(
    `UPDATE outbox_events SET delivery_state='pending', processed_at=NULL WHERE event_id=$1`, [EVENT],
  );
  const active = (await claimBatch(env.admin, 1))[0]!;
  await env.admin.query(`UPDATE outbox_events SET claimed_at=now() - interval '2 minutes' WHERE event_id=$1`, [EVENT]);
  expect(await heartbeatClaim(env.admin, EVENT, active.attempts)).toBe(true);
  expect(await reclaimStaleClaims(env.admin, 60_000)).toBe(0);
  await markDelivered(env.admin, EVENT, active.attempts);
});

it('dead-letters an expired final attempt without issuing a ninth claim', async () => {
  await env.admin.query(
    `UPDATE outbox_events
        SET delivery_state='claimed', attempts=8,
            claimed_at=now() - interval '2 minutes', processed_at=NULL
      WHERE event_id=$1`,
    [EVENT],
  );
  expect(await reclaimStaleClaims(env.admin, 60_000)).toBe(1);
  const row = await env.admin.query<{ delivery_state: string; last_error: string }>(
    `SELECT delivery_state, last_error FROM outbox_events WHERE event_id=$1`, [EVENT],
  );
  expect(row.rows[0]).toMatchObject({ delivery_state: 'dead_lettered', last_error: 'ClaimLeaseExpired' });
  expect(await claimBatch(env.admin, 1)).toEqual([]);
});
