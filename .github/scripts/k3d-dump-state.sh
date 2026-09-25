#!/usr/bin/env bash
# Dump everything needed to diagnose a failed e2e FULL run. Best-effort: every
# command is `|| true` so one missing resource can't hide the rest.
#
# Shared by `e2e full shard` and `flake focus full` — a flake check that fails
# with a thinner dump than the job that found the flake is a wasted run.
# The streamed capture from e2e-full-serve.sh first: it is the ONLY record of
# pods the run deleted (the rollout/move stories kill owners mid-run), and it
# names the pod behind every line. The kubectl dumps below see survivors only.
if [ -s /tmp/pod-logs.log ]; then
  echo "=== streamed pod logs — all replicas, including pods since deleted (last 4000 lines)"
  tail -n 4000 /tmp/pod-logs.log || true
  echo "=== end streamed pod logs ($(wc -l </tmp/pod-logs.log) lines captured in full; see the artifact)"
else
  echo "=== no streamed pod log capture (/tmp/pod-logs.log missing or empty) — stern may have failed to start"
fi

nix shell nixpkgs#kubectl -c bash -c '
  kubectl -n agent-sandbox get pods,deploy,svc,pvc,conversations -o wide || true
  # describe the not-ready workloads so a Pending pod shows its scheduling reason
  # (Insufficient cpu/mem, an unbindable PVC, a taint, …) — a bare `get` hides it.
  kubectl -n agent-sandbox describe deploy/agent-host || true
  kubectl -n agent-sandbox describe pods -l app=agent-host || true
  kubectl describe nodes || true
  kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io -o wide || true
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp | tail -120 || true
  # --prefix: without it a multi-replica selector dump is one interleaved stream
  # with no way to tell which pod wrote a line. --max-log-requests: the default
  # caps at 5 pods and ERRORS rather than truncating, which `|| true` would then
  # swallow, dumping nothing at all.
  kubectl -n agent-sandbox logs -l app=agent-host --prefix --timestamps --max-log-requests=20 --tail=1000 || true
  kubectl -n agent-sandbox logs -l app=conversation-controller --prefix --timestamps --max-log-requests=20 --tail=300 || true
  kubectl -n agent-sandbox logs -l app=conversation-router --prefix --timestamps --max-log-requests=20 --tail=300 || true
  # A container that CRASHED and restarted in a surviving pod: its pre-restart
  # logs are only reachable with --previous, and that is where the cause is.
  for p in $(kubectl -n agent-sandbox get pods -l app=agent-host -o name 2>/dev/null); do
    kubectl -n agent-sandbox logs "$p" --previous --timestamps --tail=300 2>/dev/null \
      && echo "^^^ PREVIOUS container of $p (it restarted)" || true
  done
'
