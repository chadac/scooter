"""A tiny Prometheus /metrics endpoint — no dependency, just the http.server stdlib.

Exposes the autoscale signals as gauges so they're observable (dashboards) and available to
a future HPA (custom-metrics adapter), EVEN THOUGH the controller does the scaling itself.
The controller is the single writer of agent-host replicas; this is purely read-only
observability. See todo/done/AGENT_HOST_FLEET_SCALING.md.

Gauges:
  scooter_conversations_total            — top-level conversations (demand)
  scooter_agent_host_ready_pods          — ready agent-host pods
  scooter_conversations_per_pod          — demand / ready_pods (the scale metric)
  scooter_agent_host_replicas_desired    — the controller's current target
"""

from __future__ import annotations

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("conversation-controller")

# The latest snapshot, updated each reconcile tick; served on /metrics. A plain dict guarded
# by the GIL (single writer = the reconcile loop; readers = HTTP handler threads) — the reads
# are of immutable floats, so no lock needed for correctness of a single value.
_snapshot: dict[str, float] = {
    "scooter_conversations_total": 0.0,
    "scooter_agent_host_ready_pods": 0.0,
    "scooter_conversations_per_pod": 0.0,
    "scooter_agent_host_replicas_desired": 0.0,
}


def update(demand: int, ready_pods: int, per_pod: float, target: int) -> None:
    """Update the served gauges from an autoscale pass (called by the loop)."""
    _snapshot["scooter_conversations_total"] = float(demand)
    _snapshot["scooter_agent_host_ready_pods"] = float(ready_pods)
    _snapshot["scooter_conversations_per_pod"] = float(per_pod)
    _snapshot["scooter_agent_host_replicas_desired"] = float(target)


def _render() -> bytes:
    lines: list[str] = []
    for name, value in _snapshot.items():
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")
    return ("\n".join(lines) + "\n").encode()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (stdlib signature)
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        body = _render()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 — stdlib name
        pass  # silence per-request stderr logging


def serve(port: int, stop: threading.Event) -> None:
    """Start the /metrics server in a daemon thread. Best-effort — a bind failure is logged
    and swallowed (metrics are observability, not correctness; the controller runs regardless)."""
    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    except OSError as e:
        logger.warning("metrics server failed to bind :%d (%s) — metrics disabled", port, e)
        return

    def _run() -> None:
        httpd.timeout = 1.0
        while not stop.is_set():
            httpd.handle_request()
        httpd.server_close()

    threading.Thread(target=_run, name="metrics", daemon=True).start()
    logger.info("metrics serving on :%d/metrics", port)
