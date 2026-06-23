#!/usr/bin/env bash
# Tear down the local cluster created by cluster-up.sh.
# Design/Tests stage: outline only.

set -euo pipefail
PROVIDER="${1:-k3s}"

case "$PROVIDER" in
  existing) echo "[cluster-down] existing context — nothing to tear down" ;;
  k3s)      echo "[cluster-down] TODO: k3s-uninstall.sh (or leave a shared k3s running)" ;;
  kind)     echo "[cluster-down] TODO: kind delete cluster --name agent-sandbox" ;;
  minikube) echo "[cluster-down] TODO: minikube delete -p agent-sandbox" ;;
  k3d)      echo "[cluster-down] TODO: k3d cluster delete agent-sandbox" ;;
  *) echo "unknown provider: $PROVIDER" >&2; exit 1 ;;
esac
