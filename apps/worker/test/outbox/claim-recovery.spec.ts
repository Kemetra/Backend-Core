import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../../../packages/db/__tests__/_helpers/postgres-container';
import { claimBatch } from '../../../../packages/db/src/outbox/repository';
import type { OutboxConsumer } from '@data-pulse-2/shared';
import { DrainerProcessor } from '../../src/outbox/drainer.processor';
import { OutboxConsumerRegistry } from '../../src/outbox/registry';

const TENANT = '0ca00000-0000-7000-8000-000000000102';
const EVENT = '0cc00000-0000-4000-8000-000000000102';
let env: PgTestEnv;

beforeAll(async () => {
  env = await startPgEnv();
  await applyAllUpAndCreateAppRole(env);
  await env.admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'worker-claim-recovery', 'Worker Claim Recovery')`, [TENANT]);
  await env.admin.query(
    `INSERT INTO outbox_events (event_id, tenant_id, event_type, payload)
     VALUES ($1, $2, 'test.event.recovery', '{}'::jsonb)`,
    [EVENT, TENANT],
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

it('redelivers after the first worker dies between claim and consumer', async () => {
  const abandoned = (await claimBatch(env.admin, 1))[0]!;
  expect(abandoned.event_id).toBe(EVENT);
  await env.admin.query(`UPDATE outbox_events SET claimed_at=now() - interval '2 minutes' WHERE event_id=$1`, [EVENT]);

  const handled: string[] = [];
  const consumer: OutboxConsumer<unknown> = {
    consumerId: 'test.claim-recovery',
    eventType: 'test.event.recovery',
    async handle(event) { handled.push(event.event_id); },
  };
  const registry = new OutboxConsumerRegistry();
  registry.register(consumer);
  const drainer = new DrainerProcessor({ pool: env.admin, registry });
  await drainer.tick();

  expect(handled).toEqual([EVENT]);
  const row = await env.admin.query<{ delivery_state: string; attempts: number }>(
    `SELECT delivery_state, attempts FROM outbox_events WHERE event_id=$1`, [EVENT],
  );
  expect(row.rows[0]).toMatchObject({ delivery_state: 'delivered', attempts: 2 });
});
