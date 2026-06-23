#!/usr/bin/env bash
# Bring up a local Kubernetes cluster for Tier 2/3 tests and install the
# agent-sandbox controller + load our images.
#
# Cluster-agnostic: PROVIDER in {existing,k3s,kind,minikube,k3d}. Default k3s.
# `existing` uses the current kubectl context and skips bootstrap.
#
# Design/Tests stage: outline only — steps documented, partially implemented.

set -euo pipefail
PROVIDER="${1:-k3s}"
CLUSTER_NAME="agent-sandbox"

case "$PROVIDER" in
  existing) echo "[cluster-up] using current kubectl context" ;;
  k3s)
    echo "[cluster-up] k3s"
    # k3s is the project default for local testing. Lightweight single-binary
    # cluster; ships its own containerd so images are imported via `k3s ctr`.
    # TODO (impl):
    #   curl -sfL https://get.k3s.io | sh -   (or use an existing k3s)
    #   export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
    ;;
  kind)     echo "[cluster-up] TODO: kind create cluster --name $CLUSTER_NAME" ;;
  minikube) echo "[cluster-up] TODO: minikube start -p $CLUSTER_NAME" ;;
  k3d)      echo "[cluster-up] TODO: k3d cluster create $CLUSTER_NAME" ;;
  *) echo "unknown provider: $PROVIDER" >&2; exit 1 ;;
esac

# TODO (impl), provider-independent once a cluster exists:
#  1. install the agent-sandbox controller (CRDs + controller manifests/helm)
#  2. nix build .#sandbox-image and the fake-acp-agent image; import to the
#     cluster (k3s: `sudo k3s ctr images import`; kind: `kind load`)
#  3. apply our kubenix-rendered platform manifests (namespace, RBAC, agent-host)
#  4. wait for controller + agent-host readiness
echo "[cluster-up] not fully implemented (Tests stage); provider=$PROVIDER"
