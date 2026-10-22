/**
 * RT-812 — what a migration registry entry is, and the schema reads its probe
 * is built from. A probe is how `migrate.spec` proves a migration's own objects
 * appear on `up` and disappear on its `down` (and survive anyone else's down).
 * Every migration after the frozen baseline must ship one in
 * `./migrations/<id>.ts`.
 */

/** A read-only view of the admin connection: one `COUNT(*)::text AS count` query. */
export interface ProbeDb {
  count(sql: string, params?: unknown[]): Promise<string>;
}

export interface MigrationProbe {
  /** Reads the migration's own objects, e.g. [its table, its policies, its trigger]. */
  readonly measure: (db: ProbeDb) => Promise<readonly string[]>;
  /** The reading with the migration applied. */
  readonly applied: readonly string[];
  /** The reading right after the migration's own `down`. Must differ from `applied`. */
  readonly rolledBack: readonly string[];
}

export interface MigrationEntry {
  /** The migration id: its up file name without `.sql`. */
  readonly id: string;
  /** Required for every migration after the baseline. */
  readonly probe?: MigrationProbe;
}

/** How many of the named public-schema tables exist. */
export const countTables = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(
    `SELECT COUNT(*)::text AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [names],
  );

/** How many of `columns` exist on the public-schema table. */
export const countColumns = (db: ProbeDb, table: string, columns: readonly string[]): Promise<string> =>
  db.count(
    `SELECT COUNT(*)::text AS count FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, columns],
  );

/** How many RLS policies exist on the named public-schema tables. */
export const countPolicies = (db: ProbeDb, tables: readonly string[]): Promise<string> =>
  db.count(
    `SELECT COUNT(*)::text AS count FROM pg_policies
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [tables],
  );

/** How many of the named (non-internal) triggers exist. */
export const countTriggers = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(`SELECT COUNT(*)::text AS count FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`, [
    names,
  ]);

/** How many of the named functions exist. */
export const countFunctions = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(`SELECT COUNT(*)::text AS count FROM pg_proc WHERE proname = ANY($1::text[])`, [names]);

/** How many of the named constraints exist. */
export const countConstraints = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(`SELECT COUNT(*)::text AS count FROM pg_constraint WHERE conname = ANY($1::text[])`, [names]);

/**
 * How many of the named indexes exist AND are valid. A CONCURRENTLY build the
 * runner ran inside a transaction would fail, so a valid index also proves its
 * single-statement file ran outside one.
 */
export const countValidIndexes = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(
    `SELECT COUNT(*)::text AS count FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ANY($1::text[]) AND i.indisvalid`,
    [names],
  );

/** How many of the named indexes exist in the public schema (valid or not). */
export const countIndexes = (db: ProbeDb, names: readonly string[]): Promise<string> =>
  db.count(`SELECT COUNT(*)::text AS count FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`, [
    names,
  ]);
