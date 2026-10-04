#!/usr/bin/env bash
# Census of the conv-* sandbox pods: did any of them crash during this run?
#
# Runs on EVERY e2e-full run, not only a failing one. The crash loop this exists to
# measure does not reliably fail the suite -- a sandbox can crash, be retried by the
# kubelet, and the spec still pass -- so gating the evidence behind a red run makes
# the race invisible in exactly the runs that would quantify it. Job 111556690687
# passed 5/5 with the dump skipped, and therefore says nothing about whether a
# sandbox crashed.
#
# Emits a GitHub warning annotation when any sandbox restarted, so a GREEN run still
# reports the crash instead of hiding it. ALWAYS exits 0: this is reporting, never a
# gate. Shared by the dump (k3d-dump-state.sh) and the always-on CI step.
set -uo pipefail
nix shell nixpkgs#kubectl nixpkgs#jq -c bash -c '
  echo "===== SANDBOX RESTART CENSUS (all conv pods) ====="
  pods=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null) || pods=""
  if [ -z "$pods" ]; then
    echo "  (no cluster reachable)"
    exit 0
  fi
  # ready uses tostring, not `// "?"`: jq treats false as absent, so a NOT-ready pod
  # would render as unknown -- worse than omitting it.
  echo "$pods" | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | \"  \(.metadata.name) ready=\(.status.containerStatuses[0].ready | tostring) restarts=\(.status.containerStatuses[0].restartCount // 0)\"" || true
  bad=$(echo "$pods" | jq -r "[.items[] | select(.metadata.name | startswith(\"conv-\")) | select((.status.containerStatuses[0].restartCount // 0) > 0)] | length" 2>/dev/null || echo 0)
  total=$(echo "$pods" | jq -r "[.items[] | select(.metadata.name | startswith(\"conv-\"))] | length" 2>/dev/null || echo 0)
  echo "  -> ${bad:-0} of ${total:-0} sandboxes restarted at least once"
  # A pod DELETED before this ran leaves no entry above; its events remain, so this is
  # the only trace of a crash whose conversation was already torn down.
  echo "===== BACKOFF / FAILED EVENTS (these survive pod deletion) ====="
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp -o json 2>/dev/null \
    | jq -r ".items[] | select(.reason | test(\"BackOff|Failed|Unhealthy|Killing|OOM|Evicted\")) | \"  \(.lastTimestamp) \(.reason) \(.involvedObject.name) \(.message)\"" \
    | tail -60 || true
  if [ "${bad:-0}" -gt 0 ]; then
    echo "::warning title=sandbox crash loop::${bad} of ${total} conv-* sandboxes restarted during this run"
  fi
  true
'
exit 0
