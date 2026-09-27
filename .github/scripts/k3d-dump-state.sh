#!/usr/bin/env bash
# Dump everything needed to diagnose a failed e2e FULL run. Best-effort: every
# command is `|| true` so one missing resource can't hide the rest.
#
# Shared by `e2e full shard` and `flake focus full` — a flake check that fails
# with a thinner dump than the job that found the flake is a wasted run.
nix shell nixpkgs#kubectl -c bash -c '
  kubectl -n agent-sandbox get pods,deploy,svc,pvc,conversations -o wide || true
  # describe the not-ready workloads so a Pending pod shows its scheduling reason
  # (Insufficient cpu/mem, an unbindable PVC, a taint, …) — a bare `get` hides it.
  # Every platform workload, not just agent-host: a CrashLoopBackOff reports WHY it
  # died only here, as `Last State: Terminated, Reason: …` (OOMKilled, Error, exit
  # code). Without it a SIGKILLed container is indistinguishable from one that threw.
  kubectl -n agent-sandbox describe deploy/agent-host || true
  for app in agent-host conversation-controller conversation-router; do
    kubectl -n agent-sandbox describe pods -l app="$app" || true
  done
  kubectl describe nodes || true
  kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io -o wide || true
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp | tail -120 || true
  kubectl -n agent-sandbox logs -l app=agent-host --tail=300 || true
  kubectl -n agent-sandbox logs -l app=conversation-controller --tail=150 || true
  kubectl -n agent-sandbox logs -l app=conversation-router --tail=150 || true
  # The RESTARTED containers, one pod at a time. Plain `logs` serves the CURRENT
  # attempt, so for a crash-loop it returns the fresh (still-healthy) process and
  # the fatal output is only ever in --previous. -l cannot be used: `logs -l` has no
  # --previous, so the pods are enumerated by hand.
  for app in agent-host conversation-controller conversation-router; do
    for pod in $(kubectl -n agent-sandbox get pods -l app="$app" -o name 2>/dev/null); do
      restarts=$(kubectl -n agent-sandbox get "$pod" \
        -o jsonpath="{.status.containerStatuses[0].restartCount}" 2>/dev/null || echo 0)
      [ "${restarts:-0}" -gt 0 ] || continue
      echo "===== PREVIOUS container log: $pod (restarts=$restarts) ====="
      kubectl -n agent-sandbox logs "$pod" --previous --tail=200 || true
    done
  done
'
