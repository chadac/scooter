#!/usr/bin/env python3
"""Cluster-mutation hook for the e2e-full rollout/move stories.

The browser can't run kubectl, so specs POST here to disturb the cluster
mid-conversation (the CI browser step runs this next to the port-forward):

  POST /restart        rollout-restart the agent-host Deployment and wait.
  POST /move/<thread>  delete the pod hosting <thread>'s conversation — the
                       "scale-down/rollout kills the owner mid-run" event, on
                       demand. The controller then reassigns; the test asserts
                       the UI keeps working.

  POST /gc-warmstore/<thread>
                       recreate the odin 2026-08-22 incident state on <thread>'s
                       (suspended) sandbox: repoint its `scooter-rw` overlay upper
                       at a warm-store-* pooled PVC that is TERMINATING (exists with
                       a deletionTimestamp, held by a finalizer, labelled as this
                       sandbox's own), and delete the real upper out of band.
                       Reviving such a sandbox with a plain operatingMode flip binds
                       the pod to a claim that is being deleted -> Pending forever
                       ("persistentvolumeclaim … is being deleted", the dominant live
                       variant). The heal on resume/create-adopt must re-bind it.
                       See test/e2e/warm-store-heal.spec.ts.

Deliberately boring: stdlib only, shells out to kubectl on PATH, plain-text
responses, exits with the parent step.
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

NS = "agent-sandbox"


def sh(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=180, input=stdin)


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

        if self.path.startswith("/gc-warmstore/"):
            thread = self.path.removeprefix("/gc-warmstore/")
            # conversation -> its Sandbox name (spec.sandboxRef, e.g. conv-<shortId>).
            c = sh("kubectl", "-n", NS, "get", f"conversations.scooter.chadac.dev/{thread}", "-o", "json")
            if c.returncode != 0:
                return self._reply(404, c.stderr)
            sandbox = (json.loads(c.stdout).get("spec") or {}).get("sandboxRef")
            if not sandbox:
                return self._reply(409, "conversation has no sandboxRef yet")

            # CLEAN SUSPENDED STATE FIRST. The agent-host POST /suspend returns before the
            # controller has actually torn the pod down, so a repoint now could race a pod that
            # is still up (or being recreated) — the controller would then leave a Pending pod
            # bound to the (soon-Terminating) claim that re-binding the spec can no longer fix
            # (it never recreates an already-created pod). So force operatingMode=Suspended and
            # WAIT for the pod to be gone, so the ONLY thing that next sets Running is the
            # heal-then-Running revive we are testing.
            sh("kubectl", "-n", NS, "patch", f"sandboxes.agents.x-k8s.io/{sandbox}",
               "--type=merge", "-p", json.dumps({"spec": {"operatingMode": "Suspended"}}))
            sh("kubectl", "-n", NS, "wait", "--for=delete", f"pod/{sandbox}", "--timeout=90s")

            # Read the Sandbox spec so we can rewrite its overlay volume wholesale (merge
            # patch replaces arrays atomically, so we must send the full, edited arrays).
            s = sh("kubectl", "-n", NS, "get", f"sandboxes.agents.x-k8s.io/{sandbox}", "-o", "json")
            if s.returncode != 0:
                return self._reply(404, s.stderr)
            spec = json.loads(s.stdout).get("spec") or {}
            pod_spec = (spec.get("podTemplate") or {}).get("spec") or {}
            volumes = list(pod_spec.get("volumes") or [])
            vcts = list(spec.get("volumeClaimTemplates") or [])

            # The incident: a pooled warm-store PVC named in the spec that the pool is GC'ing.
            # Recreate the DOMINANT live shape — the claim EXISTS but is TERMINATING (a
            # deletionTimestamp is set, a finalizer holds it, so it still READS 200 with its
            # labels intact). 3 of 4 live wedges reported "persistentvolumeclaim … is being
            # deleted", only 1 a plain "not found": a probe that keys on 404 alone treats the
            # terminating claim as healthy and binds a pod that can never schedule.
            #
            # So we CREATE the warm-store-* PVC ourselves, label it as THIS sandbox's own
            # (claimed-by == sandbox) so an ownership-only probe would wrongly adopt it, hold it
            # with a finalizer, then delete it (--wait=false) to leave it Terminating.
            gc_claim = f"warm-store-scooter-git-gcsim-{sandbox}"
            pvc_manifest = json.dumps({
                "apiVersion": "v1",
                "kind": "PersistentVolumeClaim",
                "metadata": {
                    "name": gc_claim,
                    "namespace": NS,
                    # A finalizer keeps the PVC in Terminating (readable, deletionTimestamp set)
                    # after the delete below — the exact shape that fools a 404-only probe.
                    "finalizers": ["scooter.chadac.dev/e2e-hold"],
                    "labels": {"scooter.io/pool-state": "claimed", "scooter.io/claimed-by": sandbox},
                },
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "resources": {"requests": {"storage": "1Gi"}},
                },
            })
            a = sh("kubectl", "-n", NS, "apply", "-f", "-", stdin=pvc_manifest)
            if a.returncode != 0:
                return self._reply(500, "create gc PVC failed\n" + a.stdout + a.stderr)

            # Repoint the suspended sandbox's overlay upper at the (soon-Terminating) claim, and
            # drop the scooter-rw volumeClaimTemplate — a claimed pool volume is a NAMED volume,
            # NOT a vct; keeping both would collide.
            volumes = [v for v in volumes if v.get("name") != "scooter-rw"]
            volumes.append({"name": "scooter-rw", "persistentVolumeClaim": {"claimName": gc_claim}})
            vcts = [t for t in vcts if (t.get("metadata") or {}).get("name") != "scooter-rw"]
            patch = json.dumps({
                "spec": {
                    "podTemplate": {"spec": {"volumes": volumes}},
                    "volumeClaimTemplates": vcts,
                }
            })
            p = sh("kubectl", "-n", NS, "patch", f"sandboxes.agents.x-k8s.io/{sandbox}",
                   "--type=merge", "-p", patch)
            if p.returncode != 0:
                return self._reply(500, p.stdout + p.stderr)

            # Now delete the gc claim out of band: the finalizer holds it, so it lands in
            # Terminating rather than vanishing — reviving the sandbox must re-bind away from it.
            d = sh("kubectl", "-n", NS, "delete", "pvc", gc_claim, "--wait=false")
            if d.returncode != 0:
                return self._reply(500, "delete gc PVC failed\n" + d.stdout + d.stderr)
            # And delete the REAL upper too (the vct-created PVC is named scooter-rw-<sandbox>).
            sh("kubectl", "-n", NS, "delete", "pvc", f"scooter-rw-{sandbox}",
               "--wait=false", "--ignore-not-found")
            return self._reply(
                200, f"repointed {sandbox} scooter-rw -> {gc_claim} (Terminating) + deleted its upper\n"
            )

        return self._reply(404, "unknown hook")

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[rollout-hook] {fmt % args}", file=sys.stderr)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8898
    print(f"[rollout-hook] listening on {port}", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), Hook).serve_forever()
