### Changed
- RT-616: successful `GET /api/v1/health/live` probes are no longer logged
  (owner decision on RT-600, 2026-10-17; VN-S6 POS terminals probe every
  10 s). `LoggingInterceptor` skips the "request completed" line for a < 400
  answer on that route template; a failure on it is still logged and HTTP
  metrics are still emitted. The `Caddyfile` proxies the route through its own
  `handle` block whose `handle_response` sets `log_skip` for a 2xx/3xx
  upstream answer only, so an upstream error, timeout or 4xx/5xx still writes
  an access-log line. `/ready` and every other route log as before. No
  contract or response change. Applying the `Caddyfile` on the pilot edge is a
  separate deploy step.
