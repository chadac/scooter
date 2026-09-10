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
  kubectl -n agent-sandbox describe deploy/agent-host || true
  kubectl -n agent-sandbox describe pods -l app=agent-host || true
  kubectl describe nodes || true
  kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io -o wide || true
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp | tail -120 || true
  kubectl -n agent-sandbox logs -l app=agent-host --tail=300 || true
  kubectl -n agent-sandbox logs -l app=conversation-controller --tail=150 || true
  kubectl -n agent-sandbox logs -l app=conversation-router --tail=150 || true
'
