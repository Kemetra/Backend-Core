# Datadog monitors and dashboard (RT-637, OBS-8)

These are the Datadog us5 definitions for the AWS lab (`env:staging`), kept as code. Datadog is the target. This directory is the source of truth, so change the JSON here and re-apply. Don't edit in the Datadog UI.

| File | What |
| --- | --- |
| `monitors.json` | 3 P1 and 3 P2 metric/service-check monitors |
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
| `p1-worker-no-data` | P1 | `trace.postgresql.query.hits{service:backend-worker}` | under 1 sampled span in 10 min | 20 min |
| `p2-api-5xx-rate` | P2 | `dp2.http_request_count` 5xx / all, 15 min | warn 2%, alert 5% | 30 min |
| `p2-api-p95-latency` | P2 | `p95:trace.http.server.request`, 30 min | warn 0.5 s, alert 1 s | 60 min |
| `p2-api-db-pool-waiters` | P2 | `min(last_10m)` of `dp2.db_pool_waiters` | above 0 for 10 min | 20 min |

## Known limits

- **New hosts join `p1-host-down` only when tagged `env:staging`.** This covers lab-02 and lab-03 once OBS-7 (RT-636) runs their agents. Each new host gets a 5-minute grace period (`new_group_delay`) after it first reports.
- **The worker has no metrics in Datadog.** Its Prometheus listener binds `127.0.0.1:9091`, so the agent cannot scrape it.
  - Queue lag (`queue_lag_seconds`) and the outbox backlog (`outbox_pending_total`) are not monitored.
  - `p1-worker-no-data` depends on the worker's idle-poll DB spans. If RT-638 finding F-B suppresses those spans, move that monitor to another worker signal first.
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
