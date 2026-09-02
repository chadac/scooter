---
name: scooter-grafana
type: knowledge
version: 1.0.0
triggers:
- grafana
- loki
- tempo
- prometheus
- logs
- query logs
- search logs
- structured logs
- kubectl logs
- nothing in the logs
- no error message
- exit 1 with no message
- silent failure
- metrics
- traces
- dashboard
- observability
- why did it fail
---

# Grafana, Loki and Tempo — you can query them

**You have read access to the platform's observability stack.** The broker
proxies `/grafana/*` to Grafana Cloud with a service-account token injected, so
you can query logs, metrics, traces and dashboards WITHOUT ever seeing the
token.

Most agents never discover this and stop at `kubectl logs`. That is usually the
wrong place to stop — see below.

## Why this matters more than `kubectl logs`

`kubectl logs` shows only what a pod is printing NOW, from a container that
still exists. Loki has the history, including the pod that already died.

The motivating case: a tool-use failure surfaced as *"commands exit 1 with no
message"*. `kubectl logs` showed nothing — the structured JSON lines carried no
error. The provider's raw stderr and its stack trace existed **only in Loki**.

So when a failure is invisible in `kubectl logs`, that is a signal to query
Loki, not evidence that there is nothing to find.

## How to call it

Through `agent-broker`, same as GitHub. **`grafana/` is the ONLY prefix** — the
path after it is a normal Grafana API path.

Two mistakes that look like the capability is broken but are just wrong paths:

- `agent-broker loki/...` → **404**. There is no `loki/` provider. Loki is
  reached THROUGH Grafana, via the datasource proxy (below).
- `agent-broker grafana/` → **HTML**. That is Grafana's UI root, proxied
  faithfully. If you get `<!DOCTYPE html>` you asked for a page, not an API.
  Every API path starts `grafana/api/`.

```bash
agent-broker grafana/api/datasources                      # what is queryable
agent-broker grafana/api/search?query=&type=dash-db       # list dashboards
```

Querying logs is a POST to the unified query endpoint. Build the body as a file
so the JSON survives quoting:

```bash
cat > /tmp/q.json <<'JSON'
{
  "queries": [{
    "refId": "A",
    "datasource": { "type": "loki", "uid": "<loki-uid-from-api/datasources>" },
    "expr": "{namespace=\"agent-sandbox\", pod=~\"agent-host.*\"} |= \"error\"",
    "maxLines": 200
  }],
  "from": "now-1h",
  "to": "now"
}
JSON
agent-broker grafana/api/ds/query -X POST \
  -H 'Content-Type: application/json' -d @/tmp/q.json
```

### Or query Loki directly through the datasource proxy

Often simpler than the unified endpoint — it is plain LogQL over GET, and the
response is Loki's own shape rather than Grafana frames:

```bash
DS=grafanacloud-logs   # from api/datasources; do NOT name this variable UID,
                       # which is readonly in the sandbox shell and fails
agent-broker "grafana/api/datasources/proxy/uid/$DS/loki/api/v1/labels"
agent-broker "grafana/api/datasources/proxy/uid/$DS/loki/api/v1/query_range?query=%7Bnamespace%3D%22agent-sandbox%22%7D&limit=50"
```

The query must be URL-encoded: `{namespace="agent-sandbox"}` becomes
`%7Bnamespace%3D%22agent-sandbox%22%7D`.

**Get the datasource `uid` from `api/datasources` first** — it is stack-specific
and guessing it returns an unhelpful error rather than a clear "no such
datasource".

## Useful LogQL for this platform

Every service logs structured JSON with a `service` field, so filter on it:

```
{namespace="agent-sandbox"} | json | service="agent-host"
{namespace="agent-sandbox"} | json | level="error"
{namespace="agent-sandbox", pod=~"conv-.*"}          # a sandbox's own logs
{namespace="agent-sandbox"} |= "<conversation-id>"   # follow one conversation
```

Widen the time range before concluding nothing is there — the default window is
often narrower than the incident.

## What you cannot do

- **Read-only.** The token is scoped `logs:read` / `traces:read` /
  `metrics:read`. Writes fail; do not try to create dashboards or alerts.
- **404: check the path before concluding anything.** A 404 on `loki/...`,
  `prometheus/...` or any non-`grafana/` prefix means that provider does not
  exist — use `grafana/api/datasources/proxy/...` instead. A 404 on a
  well-formed `grafana/api/...` path means the provider is genuinely not
  configured here (the route mounts only when both URL and token resolve); say
  so rather than retrying.
- A **401** means your request carried no broker token, which is a bug in how
  you called it, not a permissions problem.

## Do not confuse the two Grafana credentials

This deployment has two, and they are not interchangeable:

- `grafana-token` in `agent-sandbox` — **read**-scoped (`glsa_...`). The one
  behind this proxy.
- `grafana-cloud-*` in `monitoring` — **push**-only (`glc_...`), used by the
  collector to ship data. These 401 on every query endpoint.
