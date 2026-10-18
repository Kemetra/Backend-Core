# Datadog monitors and dashboard (RT-637, OBS-8)

These are the Datadog us5 definitions for the AWS lab (`env:staging`), kept as code. Datadog is the target. This directory is the source of truth, so change the JSON here and re-apply. Don't edit in the Datadog UI.

| File | What |
| --- | --- |
| `monitors.json` | 3 P1 and 6 P2 metric/service-check monitors |
| `synthetics-api-health.json` | P1 Synthetics API test on `https://lab.kemetralabs.com/api/v1/health/ready` |
| `dashboard-retail-tower-lab.json` | The "Retail Tower — lab" dashboard |
| `apply.mjs` | Idempotent create-or-update through the Datadog API |

## Alert policy (OBS-0 D8, amended 2026-10-17)

- **Email only.** P1 and P2 both go by email. Telegram is parked: adding it later means changing the notification handle, not rewriting the monitors.
- **Every metric monitor also alerts on missing data** ("no telemetry ≠ healthy"). The Synthetics test always runs, so it has no no-data state.
- **No addresses in the repo.** Messages carry the `__ALERT_RECIPIENTS__` placeholder, and `apply.mjs` fills it from `ALERT_RECIPIENTS` at apply time.
- **No PII and no business payloads** in messages or queries (OBS-1). Tags are limited to the OBS-1 set: `env`, `service`, `version`, `route`, `status_class`, `host`.

| Key | Pri | Signal | Fires when | No data after |
| --- | --- | --- | --- | --- |
| `p1-host-down` | P1 | service check `datadog.agent.up`, multi-alert by `host` | agent check CRITICAL on 2 consecutive runs | 5 min |
| `p1-api-down` | P1 | Synthetics GET `/api/v1/health/ready`, 2 locations, every 5 min, 1 retry | not 200, not JSON, or over 5 s | n/a |
| `p1-api-no-data` | P1 | `dp2.db_pool_in_use` (api scrape) | no-data only | 10 min |
| `p1-worker-no-data` | P1 | `trace.postgresql.query.hits{service:backend-worker}` | under 1 sampled span in 1 hour (`default_zero`, so an empty hour alerts) | 120 min |
| `p2-api-5xx-rate` | P2 | `dp2.http_request_count` 5xx / all, 15 min | warn 2%, alert 5% | 30 min |
| `p2-api-p95-latency` | P2 | `p95:trace.http.server.request`, 30 min | warn 0.5 s, alert 1 s | 60 min |
| `p2-api-db-pool-waiters` | P2 | `min(last_10m)` of `dp2.db_pool_waiters` | above 0 for 10 min | 20 min |
| `p2-lab02-postgres` | P2 | `postgresql.percent_usage_connections{host:retail-tower-lab-02}` | warn 70%, alert 80% | 10 min |
| `p2-lab03-mariadb` | P2 | `mysql.performance.threads_connected{host:retail-tower-lab-03}` | warn 100, alert 120 (max 151) | 10 min |
| `p2-lab03-redis` | P2 | count of reporting `redis.net.clients` series by `redis_host` on lab-03 | under 2 (10-min avg) | 10 min |

## Known limits

- **New hosts join `p1-host-down` only when tagged `env:staging`.** This covers lab-02 and lab-03 once OBS-7 (RT-636) runs their agents. Each new host gets a 5-minute grace period (`new_group_delay`) after it first reports.
- **The worker has no metrics in Datadog.** Its Prometheus listener binds `127.0.0.1:9091`, so the agent cannot scrape it.
  - Queue lag (`queue_lag_seconds`) and the outbox backlog (`outbox_pending_total`) are not monitored.
  - `p1-worker-no-data` uses the worker's DB spans. Since RT-684 (RT-638 finding F-B) the outbox drainer's idle poll is untraced, so on an idle lab those spans come from the scheduled sweeps (sale re-drive every 5 min) and from outbox events actually processed. That is why the window is 1 hour: the quietest hour on 2026-10-17/18 still had about 8 sampled queries from sweeps and processed outbox events (about 5 from the sale re-drive alone), plus their BEGIN/COMMIT/connect spans. The query uses `default_zero` because the trace metric has no points in an empty hour, which would otherwise read as no data and only fire at the 120-minute no-data backstop.
  - It now catches a dead worker within about an hour, not 10 minutes. It does not catch a drainer that has stalled while the rest of the worker runs.
- **p95 comes from 10%-sampled spans.** The OpenMetrics histogram has no percentiles. At lab traffic, the p95 is close to the slowest sampled request.
- **Trace metrics carry the api container id as `host`, not the lab host name.** Never filter APM widgets or monitors by `host`.
- **The Connector-stale P1 waits on RT-564** (the Connector heartbeat). It is not defined here.

## Apply

Run this from the repo root. Read the keys from 1Password inside the same command. Never write them to a file or echo them.

```bash
DD_API_KEY="$(op read 'op://<vault>/<item>/<field>')" \
DD_APP_KEY="$(op read 'op://<vault>/<item>/<field>')" \
ALERT_RECIPIENTS='<address>[,<address>]' \
node deploy/datadog/apply.mjs
```

`node deploy/datadog/apply.mjs --dry-run` lists what would be applied, with no network calls.

## Runbook

- **Host down / agent not reporting:**
  1. Check the host in Lightsail.
  2. On lab-01, check `docker ps` for `dp2-datadog-agent` (compose profile `datadog`).
  3. If only the agent is down, sales and postings are unaffected: telemetry never blocks them (OBS-1 §5).
- **API down:**
  1. `curl -s https://lab.kemetralabs.com/api/v1/health/ready`.
  2. Check the api container and the Caddy logs on lab-01.
- **No data from api or worker, while the host is up:** check the api `:9464` scrape and the agent's OTLP receiver (`:4318`).
- **5xx, latency or pool waiters:** start in Sentry project `backend-core`, then use this dashboard.
