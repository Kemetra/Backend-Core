### Security
- RT-762: exported spans no longer carry `db.connection_string`. The pg
  instrumentation set it to the DSN (DB host, database name, `sslmode`), which
  reached Datadog. `RedactingSpanExporter` now drops it, plus the DB identity
  attributes (`db.name`, `db.user`, `db.namespace`, `net.peer.*`,
  `server.*`) on DB spans, since OBS-1 allows none of them. `db.system`,
  `db.operation` and trace/request correlation are unchanged. Regression test:
  no exported attribute value contains both `://` and `?`. Takes effect on the
  next release; fresh-window evidence on lab-01 is pending.
