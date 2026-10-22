/**
 * RT-815 — Jest globalTeardown for apps/api.
 *
 * Fails the run if any spec changed cluster-wide roles on the shared server
 * (create, drop, attributes, password, membership): per-file databases do not
 * isolate roles, so such a spec must use `startPgEnv({ isolated: true })`.
 * Always stops the shared container.
 */
import { Client } from "pg";

import {
  RT_PG_STATE_KEY,
  SUPERUSER,
  SUPERUSER_PASSWORD,
  snapshotRoles,
  uriFor,
  type SharedState,
} from "./pg-shared-server";

export default async function globalTeardown(): Promise<void> {
  const state = (globalThis as Record<string, unknown>)[RT_PG_STATE_KEY] as SharedState | undefined;
  if (!state) return;
  const { container } = state;
  try {
    const server = { host: container.getHost(), port: container.getMappedPort(5432) };
    const client = new Client({ connectionString: uriFor(server, "postgres", SUPERUSER, SUPERUSER_PASSWORD) });
    await client.connect();
    let after: string;
    try {
      after = await snapshotRoles(client);
    } finally {
      await client.end().catch(() => undefined);
    }
    if (after !== state.roles) {
      throw new Error(
        "RT-815 role guard: cluster roles changed during the run. A spec that creates, drops or alters a role " +
          "must use startPgEnv({ isolated: true }).\n" +
          `before: ${state.roles}\nafter:  ${after}`,
      );
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}
