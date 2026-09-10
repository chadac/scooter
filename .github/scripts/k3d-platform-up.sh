#!/usr/bin/env bash
# Bring up the k3d cluster the e2e FULL target runs against: registry, cluster,
# agent-sandbox controller, platform images, and the deployed platform itself.
#
# Extracted from the `e2e full shard` job so the label-gated `flake focus full`
# job runs against an IDENTICAL cluster. Two copies of this would drift, and a
# flake check standing up a subtly different cluster from the one that produced
# the flake is worse than no check at all.
#
# Leaves behind: a running `scooter-ci` k3d cluster with the platform rolled out
# in the `agent-sandbox` namespace. Callers tear it down with
# `k3d cluster delete scooter-ci`.
set -euo pipefail

# --- cluster + registry ------------------------------------------------------
# `scooter-reg.localhost` is the trick that makes ONE image ref work on both
# sides: a `.localhost` name resolves to 127.0.0.1 on the HOST (so skopeo pushes
# to it directly) and to the registry container via docker DNS inside the
# cluster (so containerd pulls from it) — see k3dImages in flake.nix. This
# replaces the docker-daemon load + `k3d image import` tarball round-trip: every
# byte used to cross FOUR formats (nix store -> skopeo -> docker archive ->
# docker save tar -> ctr import); now skopeo streams blobs from /nix/store into
# the registry once, skipping any layer already present.
nix shell nixpkgs#k3d nixpkgs#kubectl -c bash -c '
  k3d registry create scooter-reg.localhost --port 5800
  k3d cluster create scooter-ci --no-lb --wait --registry-use k3d-scooter-reg.localhost:5800
  k3d kubeconfig merge scooter-ci --kubeconfig-merge-default
'

echo "Waiting for registry to be ready..."
max_attempts=30
attempt=0
until curl -sf http://localhost:5800/v2/ >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ $attempt -ge $max_attempts ]; then
    echo "Registry failed to become ready after ${max_attempts} attempts"
    exit 1
  fi
  echo "Registry not ready (attempt $attempt/$max_attempts), waiting..."
  sleep 2
done
echo "Registry is ready!"

# --- the Sandbox CRD + controller -------------------------------------------
# Previously unnecessary here BY ACCIDENT: the job set GOOSE_BIN=fake, which also
# forced a noop provisioner, so nothing ever touched the Sandbox API. Decoupling
# those flags (so the cluster tier tests a REAL sandbox) made this a hard
# dependency — without it the apiserver answers a plain-text "404 page not found"
# and every run ends RUN_ERROR.
#
# Same version + assets as test/support/cluster-up.sh installs locally.
base="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2"
nix shell nixpkgs#kubectl -c bash -c "
  kubectl apply -f '${base}/sandbox.yaml'
  kubectl apply -f '${base}/extensions.yaml'
  kubectl wait --for=condition=Available deploy --all -n agent-sandbox-system --timeout=180s
"

# --- platform images ---------------------------------------------------------
# attr -> content-tagged registry ref, from the flake (single source of truth with
# the platform-manifests-k3d render). Pushes run 4-wide: skopeo streams layer blobs
# straight from /nix/store, and layers shared between images (there are many — same
# nixpkgs base) upload exactly once.
refs=$(nix build .#k3d-image-refs --no-link --print-out-paths)
nix shell nixpkgs#jq -c jq -r 'to_entries[] | "\(.key)=\(.value)"' "$refs" \
  | xargs -P 4 -I{} bash -c '
      set -euo pipefail
      attr="${1%%=*}"; ref="${1#*=}"
      push_ref="localhost:${ref#*.localhost:}"
      echo "push $attr -> $ref (via $push_ref)"

      max_retries=3
      retry=0
      while [ $retry -lt $max_retries ]; do
        if nix run ".#${attr}.copyTo" -- "docker://${push_ref}" --dest-tls-verify=false; then
          echo "✓ $attr pushed successfully"
          exit 0
        fi
        retry=$((retry + 1))
        if [ $retry -lt $max_retries ]; then
          wait_time=$((retry * retry))
          echo "Push failed, retry $retry/$max_retries after ${wait_time}s..."
          sleep $wait_time
        fi
      done
      echo "ERROR: Failed to push $attr after $max_retries attempts"
      exit 1
    ' _ {}
echo "All images pushed successfully!"

# --- the platform itself -----------------------------------------------------
manifests=$(nix build .#platform-manifests-k3d --no-link --print-out-paths)
nix shell nixpkgs#kubectl -c bash -c "
  set -euo pipefail
  kubectl apply -f '${manifests}'
  # MULTI-REPLICA + SPREAD. The default topology (replicas=2, podCap=100) puts every
  # test conversation on ONE pod, so any per-pod-view bug is invisible — which is
  # exactly how the 'GET /conversations returns one pod's slice' bug reached
  # production. Force podCap=1 so each conversation lands on a DIFFERENT pod, and
  # give the fleet room to spread.
  kubectl -n agent-sandbox set env deployment/conversation-controller CONVERSATION_POD_CAP=1
  kubectl -n agent-sandbox scale deployment/agent-host --replicas=3
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/agent-host --timeout=300s
  kubectl -n agent-sandbox rollout status deployment/conversation-router --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
"
