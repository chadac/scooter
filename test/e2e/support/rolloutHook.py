#!/usr/bin/env python3
"""Cluster-mutation hook for the e2e-full rollout/move stories.

The browser cannot run kubectl, so specs POST here to disturb the cluster mid-conversation:
POST /restart rollout-restarts the agent-host Deployment and waits, and POST /move/<thread>
deletes the pod hosting <thread>'s conversation so the controller reassigns it. The warm-store
stories read and disturb the overlay pool: GET /overlay/<thread>, GET /pool, POST and GET
/canary/<thread>, POST /warm-store/scale/<n>. POST /pooler/restart rolls the PgBouncer pooler and GET /db/connections lists
the server's client sessions. POST /locked-folder and DELETE /locked-folder/<id>
manage a user's locked folder as the broker, the only way to make one. POST /k8s/<thread>
calls a broker k8s tool from that conversation's sandbox; GET /pod-ready/<thread> reports whether its sandbox pod is Ready. GET /k8s/pod/<thread>,
/k8s/mark/<thread>, /k8s/configmap/<name> and /k8s/broker-can/<verb>/<resource> read back
what it did. Stdlib only, shells out to
kubectl on PATH.
"""

from __future__ import annotations

import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

NS = "agent-sandbox"

def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=180)

# A file in the overlay volume's root, outside the overlay itself.
CANARY = "/nix/.scooter-rw/e2e-canary"
POOL_LABEL = "scooter.io/pool"
# What the k8s spec's approved exec writes in the sandbox.
K8S_MARK = "/tmp/k8s-e2e-mark"
WSC_SELECTOR = "app=warm-store-controller"

def kget(*args: str) -> dict | None:
    r = sh("kubectl", "-n", NS, "get", *args, "-o", "json")
    return json.loads(r.stdout) if r.returncode == 0 else None

def pv_view(pv: dict) -> dict:
    meta = pv["metadata"]
    ref = pv["spec"].get("claimRef") or {}
    return {
        "name": meta["name"],
        "phase": pv.get("status", {}).get("phase"),
        "pool": meta.get("labels", {}).get(POOL_LABEL),
        "annotations": {k: v for k, v in meta.get("annotations", {}).items() if k.startswith("scooter.io/")},
        "claim": ref.get("name"),
        "storageClass": pv["spec"].get("storageClassName"),
    }

def as_folder_service(method: str, path: str, user: str, body: dict | None = None) -> tuple[int, str]:
    """Call the router's /folders as agent-broker, an allowlisted folder service."""
    tok = sh("kubectl", "-n", NS, "create", "token", "agent-broker", "--audience", "scooter-router")
    if tok.returncode != 0:
        return 500, tok.stderr
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    # svc/agent-host fronts the conversation-router.
    pf = subprocess.Popen(["kubectl", "-n", NS, "port-forward", "svc/agent-host", f"{port}:8080"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        if "Forwarding from" not in (pf.stdout.readline() if pf.stdout else ""):
            return 500, "port-forward to the router failed"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {tok.stdout.strip()}", "X-Scooter-User": user,
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
    finally:
        pf.terminate()
        pf.wait()

def mcp_call(thread: str, tool: str, arguments: dict) -> tuple[int, str]:
    """Call a broker MCP tool as the sandbox does, with its own ServiceAccount token."""
    rpc = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": tool, "arguments": arguments}})
    r = subprocess.run(
        ["kubectl", "-n", NS, "exec", "-i", sandbox_of(thread), "-c", "sandbox", "--",
         "agent-broker", "mcp/", "-X", "POST", "-H", "Content-Type: application/json",
         "-H", "Accept: application/json, text/event-stream", "--data-binary", "@-"],
        input=rpc, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return 500, r.stdout + r.stderr
    # Streamable HTTP may answer as an SSE frame; the last data line is the reply.
    frames = [ln.partition("data:")[2] for ln in r.stdout.splitlines() if ln.startswith("data:")]
    try:
        reply = json.loads(frames[-1] if frames else r.stdout)
    except ValueError:
        return 502, r.stdout
    if "error" in reply:
        return 502, json.dumps(reply["error"])
    result = reply["result"]
    text = "\n".join(b.get("text", "") for b in result.get("content") or [])
    return 200, json.dumps({"error": bool(result.get("isError")), "text": text})

def thread_ok(thread: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9-]+", thread) is not None

def sandbox_of(thread: str) -> str:
    """The Sandbox name; mirrors shortId in services/agent-host/src/session/manager.ts."""
    h = 0
    for c in thread:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    n = abs(h - (1 << 32) if h >= 1 << 31 else h)
    digits = ""
    while True:
        n, r = divmod(n, 36)
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + digits
        if n == 0:
            return f"conv-{digits}"

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

        if self.path == "/pooler/restart":
            r = sh("kubectl", "-n", NS, "rollout", "restart", "deployment/agent-shared-db-pooler")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            w = sh("kubectl", "-n", NS, "rollout", "status", "deployment/agent-shared-db-pooler", "--timeout=180s")
            return self._reply(200 if w.returncode == 0 else 500, w.stdout + w.stderr)

        if self.path.startswith("/move/"):
            thread = self.path.removeprefix("/move/")
            # The owner is the conversations row's host_pod, read in the shared Postgres pod.
            if not re.fullmatch(r"[A-Za-z0-9-]+", thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "exec", "deploy/agent-shared-db", "-c", "postgres", "--",
                   "psql", "-U", "postgres", "-d", "agent_host", "-tAc",
                   f"SELECT coalesce(host_pod, '') FROM conversations WHERE id = '{thread}'")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            host = r.stdout.strip()
            if not host:
                return self._reply(409, "conversation has no row or no host_pod yet")
            d = sh("kubectl", "-n", NS, "delete", "pod", host, "--wait=false")
            return self._reply(200 if d.returncode == 0 else 500, f"deleted {host}\n" + d.stderr)

        if self.path.startswith("/canary/"):
            thread = self.path.removeprefix("/canary/")
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
            if not (thread_ok(thread) and thread_ok(body)):
                return self._reply(400, "bad conversation id or canary")
            r = sh("kubectl", "-n", NS, "exec", sandbox_of(thread), "-c", "sandbox", "--",
                   "sh", "-c", f"echo {body} > {CANARY} && sync")
            return self._reply(200 if r.returncode == 0 else 500, r.stdout + r.stderr)

        if self.path == "/locked-folder":
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if not (isinstance(req.get("user"), str) and req["user"] and isinstance(req.get("name"), str)):
                return self._reply(400, "want {user, name}")
            code, out = as_folder_service("POST", "/folders", req["user"], {"name": req["name"], "locked": True})
            return self._reply(code, out)

        if self.path.startswith("/k8s/"):
            thread = self.path.removeprefix("/k8s/")
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if not (thread_ok(thread) and isinstance(req.get("tool"), str) and req["tool"].startswith("k8s_")):
                return self._reply(400, "want /k8s/<thread> with {tool: k8s_*, arguments}")
            code, out = mcp_call(thread, req["tool"], req.get("arguments") or {})
            return self._reply(code, out)

        m = re.fullmatch(r"/warm-store/scale/([01])", self.path)
        if m:
            r = sh("kubectl", "-n", NS, "scale", "deployment/warm-store-controller", f"--replicas={m[1]}")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            # Scale-down waits for the pod to go, so /reserve is really unreachable afterwards.
            w = (sh("kubectl", "-n", NS, "rollout", "status", "deployment/warm-store-controller", "--timeout=180s")
                 if m[1] == "1" else
                 sh("kubectl", "-n", NS, "wait", "--for=delete", "pod", "-l", WSC_SELECTOR, "--timeout=120s"))
            return self._reply(200 if w.returncode == 0 else 500, w.stdout + w.stderr)

        return self._reply(404, "unknown hook")

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        if self.path == "/db/connections":
            # Server-side client sessions, marked by whether they arrive from the pooler.
            pods = kget("pods", "-l", "app=agent-shared-db-pooler")
            if pods is None:
                return self._reply(404, "no pooler pods")
            pooler = {p["status"].get("podIP") for p in pods["items"]} - {None}
            r = sh("kubectl", "-n", NS, "exec", "deploy/agent-shared-db", "-c", "postgres", "--",
                   "psql", "-U", "postgres", "-tA", "-F", "\t", "-c",
                   "SELECT usename, coalesce(host(client_addr), ''), left(query, 60) FROM pg_stat_activity"
                   " WHERE backend_type = 'client backend' AND usename <> 'postgres'")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            rows = [line.split("\t", 2) for line in r.stdout.splitlines() if line.count("\t") >= 2]
            return self._json(200, {
                "poolerIps": sorted(pooler),
                "connections": [{"user": u, "addr": a, "query": q, "viaPooler": a in pooler} for u, a, q in rows],
            })

        if self.path == "/pool":
            pvs = (kget("pv") or {"items": []})["items"]
            idle = [pv_view(pv) for pv in pvs
                    if POOL_LABEL in pv["metadata"].get("labels", {}) and pv.get("status", {}).get("phase") == "Available"]
            return self._json(200, idle)

        if self.path.startswith("/overlay/"):
            # The PV the overlay PVC is bound to, else the PV that last served the sandbox.
            thread = self.path.removeprefix("/overlay/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            sandbox = sandbox_of(thread)
            pvc = kget("pvc", f"scooter-rw-{sandbox}")
            pvs = (kget("pv") or {"items": []})["items"]
            bound = pvc["spec"].get("volumeName") if pvc else None
            pv = next((p for p in pvs if p["metadata"]["name"] == bound), None) or next(
                (p for p in pvs if p["metadata"].get("annotations", {}).get("scooter.io/last-sandbox") == sandbox), None)
            return self._json(200, {
                "sandbox": sandbox,
                "pvc": None if pvc is None else {
                    "phase": pvc.get("status", {}).get("phase"),
                    "volume": bound,
                    "storageClass": pvc["spec"].get("storageClassName"),
                    "labels": pvc["metadata"].get("labels", {}),
                },
                "pv": None if pv is None else pv_view(pv),
            })

        if self.path.startswith("/pod-ready/"):
            # "True" or "False" from the pod's Ready condition, or "absent" with no pod.
            thread = self.path.removeprefix("/pod-ready/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "get", "pod", sandbox_of(thread), "--ignore-not-found",
                   "-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
            if r.returncode != 0:
                return self._reply(500, r.stderr)
            return self._reply(200, r.stdout.strip() or "absent")

        if self.path.startswith("/k8s/pod/"):
            thread = self.path.removeprefix("/k8s/pod/")
            return self._reply(200, sandbox_of(thread)) if thread_ok(thread) else self._reply(400, "bad conversation id")

        if self.path.startswith("/k8s/mark/"):
            thread = self.path.removeprefix("/k8s/mark/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "exec", sandbox_of(thread), "-c", "sandbox", "--", "cat", K8S_MARK)
            return self._reply(200 if r.returncode == 0 else 404, r.stdout.strip() or r.stderr)

        m = re.fullmatch(r"/k8s/configmap/([a-z0-9-]+)", self.path)
        if m:
            cm = kget("configmap", m[1])
            return self._json(200, cm.get("data") or {}) if cm else self._reply(404, "no such configmap")

        m = re.fullmatch(r"/k8s/broker-can/([a-z]+)/([a-z/]+)", self.path)
        if m:
            r = sh("kubectl", "-n", NS, "auth", "can-i", m[1], m[2],
                   f"--as=system:serviceaccount:{NS}:agent-broker")
            # can-i exits 1 for "no", which is an answer, not a failure.
            return self._reply(200 if r.stdout.strip() in ("yes", "no") else 500, r.stdout.strip() or r.stderr)

        if self.path.startswith("/canary/"):
            thread = self.path.removeprefix("/canary/")
            if not thread_ok(thread):
                return self._reply(400, "bad conversation id")
            r = sh("kubectl", "-n", NS, "exec", sandbox_of(thread), "-c", "sandbox", "--", "cat", CANARY)
            return self._reply(200 if r.returncode == 0 else 404, r.stdout.strip() or r.stderr)

        return self._reply(404, "unknown hook")

    def do_DELETE(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler contract
        k = re.fullmatch(r"/k8s/configmap/([a-z0-9-]+)", self.path)
        if k:
            r = sh("kubectl", "-n", NS, "delete", "configmap", k[1], "--ignore-not-found")
            return self._reply(200 if r.returncode == 0 else 500, r.stdout + r.stderr)
        m = re.fullmatch(r"/locked-folder/([A-Za-z0-9-]+)", self.path)
        user = self.headers.get("X-Scooter-User") or ""
        if not (m and user):
            return self._reply(404, "unknown hook")
        code, out = as_folder_service("DELETE", f"/folders/{m[1]}?subfolders=delete", user)
        return self._reply(code, out)

    def _json(self, code: int, body: object) -> None:
        self._reply(code, json.dumps(body))

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[rollout-hook] {fmt % args}", file=sys.stderr)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"[rollout-hook] listening on {port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), Hook).serve_forever()
