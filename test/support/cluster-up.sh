#!/usr/bin/env bash
# Bring up a local Kubernetes cluster for Tier 2/3 tests and install the
# agent-sandbox controller + load our images.
#
# Cluster-agnostic: PROVIDER in {existing,kind,minikube,k3d}. `existing` uses the
# current kubectl context and skips bootstrap.
#
# Design/Tests stage: outline only — steps are documented, not yet implemented.

set -euo pipefail
PROVIDER="${1:-kind}"

case "$PROVIDER" in
  existing) echo "[cluster-up] using current kubectl context" ;;
  kind)     echo "[cluster-up] TODO: kind create cluster --name agent-sandbox" ;;
  minikube) echo "[cluster-up] TODO: minikube start -p agent-sandbox" ;;
  k3d)      echo "[cluster-up] TODO: k3d cluster create agent-sandbox" ;;
  *) echo "unknown provider: $PROVIDER" >&2; exit 1 ;;
esac

# TODO (impl):
#  1. install the agent-sandbox controller (helm/ kubectl apply CRDs+controller)
#  2. nix build .#sandbox-image and the fake-acp-agent image; load into the cluster
#  3. apply our kubenix-rendered manifests (namespace, RBAC, agent-host)
#  4. wait for controller + agent-host readiness
echo "[cluster-up] not implemented (Tests stage)"
