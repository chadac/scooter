#!/usr/bin/env bash
# Expose the deployed platform to a Playwright FULL run, and start the
# out-of-browser helpers those specs need. SOURCE this, don't execute it:
#
#     . .github/scripts/e2e-full-serve.sh
#     nix develop --command bash -c 'npx playwright test --project=full ...'
#
# Sourcing matters — the background PIDs and the cleanup `trap` have to live in
# the STEP's shell, so they survive until the playwright run finishes and are
# reaped when the step ends. Run as a subprocess instead and the trap fires
# immediately, killing the port-forward out from under the tests.
#
# Returns only once the UI actually answers a GET (see below). Callers are
# expected to have `set -euo pipefail`.

# Port-forward the `ui` Service: nginx serving the static build AND proxying the
# API, so ONE origin answers both the app and /conversations — the browser's real
# topology, not a test-only arrangement.
nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox rollout status deployment/ui --timeout=180s
nix shell nixpkgs#kubectl -c kubectl -n agent-sandbox port-forward svc/ui 8899:8080 >/tmp/pf.log 2>&1 &
PF_PID=$!

# CLUSTER SAMPLER: every 15s, the node's Allocated-resources table + the pod
# list. A sandbox Pending on Insufficient cpu leaves NO trace in pod logs and had
# rolled out of the events tail by dump time in three straight failures — this
# keeps the resource timeline of the whole run.
( while true; do
    echo "== $(date -u +%H:%M:%S)"
    nix shell nixpkgs#kubectl -c bash -c '
      kubectl get pods -n agent-sandbox -o wide 2>/dev/null | grep -v Completed
      kubectl describe nodes 2>/dev/null | grep -A8 "Allocated resources"'
    sleep 15
  done >/tmp/cluster-sampler.log 2>&1 ) &
SAMPLER_PID=$!

# The rollout/move hook: lets the browser specs disturb the cluster (delete the
# owner pod mid-run / restart the deployment) — kubectl runs HERE, not in the
# browser. Activates the reassignment stories.
nix shell nixpkgs#kubectl -c python3 test/e2e/support/rolloutHook.py 8898 >/tmp/rollout-hook.log 2>&1 &
HOOK_PID=$!

trap 'kill "$PF_PID" "$SAMPLER_PID" "$HOOK_PID" 2>/dev/null || true' EXIT

# Wait on a real GET, not the port bind — the forward accepts before nginx serves.
for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8899/ && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:8899/ || { echo "the UI never served:"; cat /tmp/pf.log; exit 1; }
