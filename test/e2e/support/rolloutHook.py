#!/usr/bin/env python3
"""Cluster-mutation hook for the e2e-full rollout/move stories.

The browser can't run kubectl, so specs POST here to disturb the cluster
mid-conversation (the CI browser step runs this next to the port-forward):

  POST /restart        rollout-restart the agent-host Deployment and wait.
  POST /move/<thread>  delete the pod hosting <thread>'s conversation — the
                       "scale-down/rollout kills the owner mid-run" event, on
                       demand. The controller then reassigns; the test asserts
                       the UI keeps working.

Deliberately boring: stdlib only, shells out to kubectl on PATH, plain-text
responses, exits with the parent step.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

NS = "agent-sandbox"


def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=180)


class Hook(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: str) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        if self.path == "/restart":
            r = sh("kubectl", "-n", NS, "rollout", "restart", "deployment/agent-host")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            w = sh("kubectl", "-n", NS, "rollout", "status", "deployment/agent-host", "--timeout=180s")
            return self._reply(200 if w.returncode == 0 else 500, w.stdout + w.stderr)

        if self.path.startswith("/move/"):
            thread = self.path.removeprefix("/move/")
            r = sh("kubectl", "-n", NS, "get", f"conversations.scooter.chadac.dev/{thread}", "-o", "json")
            if r.returncode != 0:
                return self._reply(404, r.stderr)
            host = (json.loads(r.stdout).get("status") or {}).get("hostPod")
            if not host:
                return self._reply(409, "conversation has no hostPod yet")
            d = sh("kubectl", "-n", NS, "delete", "pod", host, "--wait=false")
            return self._reply(200 if d.returncode == 0 else 500, f"deleted {host}\n" + d.stderr)

        return self._reply(404, "unknown hook")

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[rollout-hook] {fmt % args}", file=sys.stderr)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"[rollout-hook] listening on {port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), Hook).serve_forever()
