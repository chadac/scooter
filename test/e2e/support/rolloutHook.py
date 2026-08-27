#!/usr/bin/env python3
"""Cluster-mutation hook for the e2e-full rollout/move stories.

The browser can't run kubectl, so specs POST here to disturb the cluster
mid-conversation (the CI browser step runs this next to the port-forward):

  POST /restart        rollout-restart the agent-host Deployment and wait.
  POST /move/<thread>  delete the pod hosting <thread>'s conversation — the
                       "scale-down/rollout kills the owner mid-run" event, on
                       demand. The controller then reassigns; the test asserts
                       the UI keeps working.
  POST /wipe-local/<thread>
                       delete <thread>'s directory under the owner pod's
                       LOCAL_STATE_PATH emptyDir, WITHOUT killing the pod —
                       the rollout's cache wipe in isolation. A rollout
                       replaces the pod and its emptyDir together; this
                       reproduces only the wipe half, so a test can tell a
                       read that answers from the durable mirror apart from
                       one that answers from the local cache. Unlike /restart
                       it disturbs no other conversation on the fleet.
                       Returns the deleted path + the pod it ran in.

Deliberately boring: stdlib only, shells out to kubectl on PATH, plain-text
responses, exits with the parent step.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

NS = "agent-sandbox"


LOCAL_STATE_PATH = "/var/lib/agent-host/conversations"  # modules/platform.nix


def sh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=180)


def host_pod(thread: str) -> tuple[str | None, int, str]:
    """The agent-host pod currently hosting `thread`, per its Conversation CR.

    Returns (pod, status, detail) — pod is None when the CR is missing (404) or
    has not been assigned an owner yet (409). Shared by /move and /wipe-local so
    both disturb the SAME pod the conversation actually lives on; targeting any
    other pod would be a no-op that silently looks like a pass.
    """
    r = sh("kubectl", "-n", NS, "get", f"conversations.scooter.chadac.dev/{thread}", "-o", "json")
    if r.returncode != 0:
        return None, 404, r.stderr
    pod = (json.loads(r.stdout).get("status") or {}).get("hostPod")
    if not pod:
        return None, 409, "conversation has no hostPod yet"
    return pod, 200, ""


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
            host, status, detail = host_pod(thread)
            if not host:
                return self._reply(status, detail)
            d = sh("kubectl", "-n", NS, "delete", "pod", host, "--wait=false")
            return self._reply(200 if d.returncode == 0 else 500, f"deleted {host}\n" + d.stderr)

        if self.path.startswith("/wipe-local/"):
            thread = self.path.removeprefix("/wipe-local/")
            # Reject anything that could escape the state dir. The thread id comes
            # off a URL and lands in an `rm -rf` inside a pod, so validate it rather
            # than trusting it: ids are uuid-ish, and a path separator or `..` here
            # would delete something else entirely.
            if not thread or not all(c.isalnum() or c in "-_" for c in thread):
                return self._reply(400, f"refusing to wipe a non-id path component: {thread!r}")
            host, status, detail = host_pod(thread)
            if not host:
                return self._reply(status, detail)
            target = f"{LOCAL_STATE_PATH}/{thread}"
            # `rm -rf` is idempotent, so a conversation whose local copy is ALREADY
            # absent (never written on this pod) still returns 200 — the postcondition
            # "the owner pod has no local copy" is what the caller needs, not "a
            # directory was removed". Report what was there so a test artifact shows it.
            # /bin/sh by absolute path: the agent-host image sets no PATH of its own
            # (pkgs/agent-host-image/default.nix config.Env), so a bare `sh` depends on
            # the container runtime's default. buildEnv links coreutils + bash into /bin,
            # so this path is the one guaranteed to exist.
            r = sh("kubectl", "-n", NS, "exec", host, "-c", "agent-host", "--",
                   "/bin/sh", "-c", f"ls -1 '{target}' 2>/dev/null; rm -rf '{target}'")
            if r.returncode != 0:
                return self._reply(500, f"wipe failed on {host}: {r.stderr}")
            return self._reply(200, f"wiped {target} on {host}\nheld: {r.stdout.strip() or '(nothing)'}\n")

        return self._reply(404, "unknown hook")

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[rollout-hook] {fmt % args}", file=sys.stderr)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"[rollout-hook] listening on {port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), Hook).serve_forever()
