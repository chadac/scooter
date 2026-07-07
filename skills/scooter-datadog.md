---
name: scooter-datadog
type: knowledge
version: 1.0.0
triggers:
- datadog
- dd-api
- metrics query
- query metrics
- logs search
- monitor status
- monitors
- observability
- apm
- dashboards
---

# Querying Datadog (scooter-datadog)

You can query Datadog — metrics, logs, monitors, dashboards — through the
credential broker. You do **not** have the Datadog API keys and never see them:
the broker injects `DD-API-KEY` + `DD-APPLICATION-KEY` on the outbound request
and returns Datadog's normal JSON response.

Use the `agent-broker` CLI, which proxies `/datadog/<path>` to the Datadog API
(`https://api.<site>`). It's a thin `curl` wrapper — pass the API path and any
`curl` args:

```bash
agent-broker "datadog/<api-path>" [curl-args...]
```

If a `datadog/...` call returns 404 at the broker, the provider is not enabled in
this deployment (no keys configured) — tell the user rather than retrying.

## Common queries

Query a metric time series (v1 — `from`/`to` are UNIX seconds):

```bash
now=$(date +%s); from=$((now-3600))
agent-broker "datadog/api/v1/query?from=${from}&to=${now}&query=avg:system.cpu.user{*}"
```

Search logs (v2 — POST a JSON body):

```bash
agent-broker -X POST "datadog/api/v2/logs/events/search" \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"query":"service:web status:error","from":"now-15m","to":"now"},"page":{"limit":25}}'
```

List / inspect monitors:

```bash
agent-broker "datadog/api/v1/monitor"                 # all monitors
agent-broker "datadog/api/v1/monitor/search?query=status:alert"
agent-broker "datadog/api/v1/monitor/<monitor_id>"    # one monitor
```

List dashboards:

```bash
agent-broker "datadog/api/v1/dashboard"
```

## Notes

- The path after `datadog/` is passed straight to the Datadog API — consult
  Datadog's API docs for the exact endpoint/params. Both v1 and v2 endpoints work.
- Prefer **read** endpoints (query/search/get). Datadog writes (muting monitors,
  posting events) also go through the same proxy, but only do them when the task
  clearly asks for it.
- The Datadog **site** (region) is configured broker-side; you don't set it — just
  use the `api/...` path and the broker targets the right host.
