#!/usr/bin/env bash
# Bring up the k3d cluster the e2e full target runs against: registry, cluster,
# agent-sandbox controller, platform images, and the deployed platform itself.
# Shared by the `e2e full shard` and `flake focus full` jobs so both stand up an
# identical cluster. Leaves behind a running `scooter-ci` k3d cluster with the
# platform rolled out in the `agent-sandbox` namespace; callers tear it down with
# `k3d cluster delete scooter-ci`.
set -euo pipefail

# --- phase timing ------------------------------------------------------------
# `phase` stamps each boundary and the exit trap prints a per-phase breakdown.
_PHASE_T0=$(date +%s)
_PHASE_LAST=$_PHASE_T0
_PHASE_LOG=""
_PHASE_NAME="startup"

phase() {
  local now; now=$(date +%s)
  _PHASE_LOG="${_PHASE_LOG}${_PHASE_NAME}=$((now - _PHASE_LAST))s\n"
  _PHASE_LAST=$now
  _PHASE_NAME="$1"
  echo "::group::[phase] $1"
}

_phase_summary() {
  local now; now=$(date +%s)
  _PHASE_LOG="${_PHASE_LOG}${_PHASE_NAME}=$((now - _PHASE_LAST))s\n"
  echo "::endgroup::"
  echo "=== k3d-platform-up phase breakdown ==="
  printf "%b" "$_PHASE_LOG" | sed 's/^/  /'
  echo "  TOTAL=$((now - _PHASE_T0))s"
}
trap _phase_summary EXIT

# --- flake deps, realised in the background ---------------------------------
# One build of every flake output needed, overlapping cluster bring-up.
_deps_out=$(mktemp) _deps_log=$(mktemp)
(
  t0=$(date +%s)
  # A prebuilt store path substitutes from Cachix without evaluating.
  if [ -n "${K3D_CI_DEPS:-}" ] \
     && nix build "$K3D_CI_DEPS" --no-link --print-out-paths >"$_deps_out"; then
    echo "[phase] deps-realise=$(( $(date +%s) - t0 ))s (prebuilt $K3D_CI_DEPS)"
  else
    [ -n "${K3D_CI_DEPS:-}" ] && echo "::warning::could not substitute $K3D_CI_DEPS; evaluating locally"
    nix build .#k3d-ci-deps --no-link --print-out-paths >"$_deps_out"
    echo "[phase] deps-eval+build=$(( $(date +%s) - t0 ))s"
  fi
) >"$_deps_log" 2>&1 &
_deps_pid=$!

phase "cluster+registry"
# --- cluster + registry ------------------------------------------------------
# Before the caches below are mounted, so an emptied one is not in use.
"$(dirname "$0")/k3d-cache-trim.sh"

# A `.localhost` name resolves to 127.0.0.1 on the host (skopeo pushes to it) and
# to the registry container inside the cluster (containerd pulls from it), so one
# image ref works on both sides; see k3dImages in flake.nix.
nix shell nixpkgs#k3d nixpkgs#kubectl -c bash -c '
  # Persist the registry blob store when the runner provides one (self-hosted
  # bind-mounts /var/lib/k3d-registry), so pushes can skip layers already present.
  reg_vol=""
  [ -d /var/lib/k3d-registry ] && reg_vol="-v /var/lib/k3d-registry:/var/lib/registry"

  # Persist the node content store for the same reason, for the images pulled
  # from Docker Hub (postgres, alpine/k8s, busybox).
  ctd_vol=""
  [ -d /var/lib/k3d-containerd ] && ctd_vol="-v /var/lib/k3d-containerd:/var/lib/rancher/k3s/agent/containerd"

  # Reuse an existing registry, since `flake-focus-full` runs this script twice in
  # one job.
  # Anchored on the column separator or end-of-line because `k3d registry list`
  # pads a table, and double-quoted with `\$` because this block is inside a
  # single-quoted `bash -c`.
  if k3d registry list 2>/dev/null | grep -qE "^k3d-scooter-reg\.localhost([[:space:]]|\$)"; then
    echo "registry k3d-scooter-reg.localhost is already up — reusing its blob store"
  else
    # shellcheck disable=SC2086  # intentional word-split: empty means "no flag"
    k3d registry create scooter-reg.localhost --port 5800 $reg_vol
  fi
  # shellcheck disable=SC2086  # intentional word-split: empty means "no flag"
  k3d cluster create scooter-ci --no-lb --wait --registry-use k3d-scooter-reg.localhost:5800 $ctd_vol
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

phase "sandbox-crd+controller"
# --- the Sandbox CRD + controller -------------------------------------------
# Required because the cluster tier provisions a real sandbox; same version and
# assets as test/support/cluster-up.sh installs locally.
base="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2"
nix shell nixpkgs#kubectl -c bash -c "
  kubectl apply -f '${base}/sandbox.yaml'
  kubectl apply -f '${base}/extensions.yaml'
  kubectl wait --for=condition=Available deploy --all -n agent-sandbox-system --timeout=180s
"

phase "platform-images-push"
# --- platform images ---------------------------------------------------------
_deps_rc=0
wait "$_deps_pid" || _deps_rc=$?
cat "$_deps_log"
if [ "$_deps_rc" -ne 0 ]; then
  echo "ERROR: building .#k3d-ci-deps failed (exit $_deps_rc)"
  exit 1
fi
deps=$(tail -n1 "$_deps_out")
echo "[phase] deps-wait=$(( $(date +%s) - _PHASE_LAST ))s"
refs="$deps/image-refs.json"

push_attrs=(
  agent-host-image
  ui-image
  broker-image
  webhooks-image
  sandbox-os-image
  conversation-controller-image
  conversation-router-image
  db-migrator-image
  byoc-controller-image
  warm-store-controller-image
)


# The refs map -> a bash array in push_attrs order, in one jq call; `--args` goes
# after the file or jq reads the filename as an arg and blocks on stdin.
mapfile -t push_refs < <(
  nix shell nixpkgs#jq -c jq -r '
      . as $m | $ARGS.positional[] | $m[.]
    ' "$refs" --args "${push_attrs[@]}"
)
if [ "${#push_refs[@]}" -ne "${#push_attrs[@]}" ]; then
  echo "ERROR: resolved ${#push_refs[@]} refs, expected ${#push_attrs[@]}"
  exit 1
fi

# Exported for the xargs subshells, which inherit the environment but not shell
# variables.
export DEPS="$deps"

_push_copy_t0=$(date +%s)
# attr=ref per line.
for _i in "${!push_attrs[@]}"; do
  printf '%s=%s\n' "${push_attrs[$_i]}" "${push_refs[$_i]}"
done \
  | xargs -P 4 -I{} bash -c '
      set -euo pipefail
      attr="${1%%=*}"; ref="${1#*=}"
      push_ref="localhost:${ref#*.localhost:}"

      # Tags are content-addressed, so a tag already in the registry holds exactly
      # the bytes about to be pushed, and skipping the push also skips its Nix
      # evaluation; a registry that does not answer falls through to a real push.
      repo="${push_ref#*/}"; repo="${repo%%:*}"
      tag="${push_ref##*:}"
      # Every blob the manifest names must be present too, since a manifest that
      # outlived its blobs would otherwise be skipped here and fail every pull.
      if manifest=$(curl -sf --max-time 5 \
           "http://localhost:5800/v2/${repo}/manifests/${tag}" \
           -H "Accept: application/vnd.oci.image.manifest.v1+json" \
           -H "Accept: application/vnd.docker.distribution.manifest.v2+json" 2>/dev/null); then
        complete=1
        for digest in $(printf "%s" "$manifest" | grep -oE "sha256:[0-9a-f]{64}" | sort -u); do
          curl -sfI -o /dev/null --max-time 5 "http://localhost:5800/v2/${repo}/blobs/${digest}" \
            || { complete=0; echo "~ $attr manifest at $tag is missing blob $digest -- re-pushing"; break; }
        done
        if [ "$complete" = 1 ]; then
          echo "= $attr already in registry at $tag -- skipping push"
          exit 0
        fi
      fi

      echo "push $attr -> $ref (via $push_ref)"

      max_retries=3
      retry=0
      while [ $retry -lt $max_retries ]; do
        # copyTo bundles a substitutable skopeo, and the batched `nix build` above
        # has already realised the graph, so this evaluation is a cache hit.
        if "${DEPS}/${attr}.copyTo/bin/copy-to" "docker://${push_ref}" --dest-tls-verify=false; then
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
echo "[phase] image-blob-copy=$(( $(date +%s) - _push_copy_t0 ))s"
echo "All images pushed successfully!"

phase "platform-rollout"
# --- the platform itself -----------------------------------------------------
# From the single build in the push phase.
manifests="$deps/platform-manifests-k3d.yaml"
nix shell nixpkgs#kubectl -c bash -c "
  set -euo pipefail
  kubectl apply -f '${manifests}'
  # The conv-token signing key, which modules/platform.nix requires; created
  # out-of-band like a real deploy, idempotently.
  kubectl -n agent-sandbox create secret generic agent-conv-token-secret \
    --from-literal=secret=\"\$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')\" \
    --dry-run=client -o yaml | kubectl apply -f -
  # BYOC's join-token key, required once scooter.byoc.enable is on.
  kubectl -n agent-sandbox create secret generic agent-remote-join-secret \
    --from-literal=secret=\"\$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')\" \
    --dry-run=client -o yaml | kubectl apply -f -
  # Postgres accepts TCP before it is usable (roles from agent-postgres-init,
  # schema from agent-db-migrate), so wait on both Jobs, selected by label since
  # their names carry a spec hash. The init Job's reader grants wait on the
  # migrated tables, so it completes after agent-db-migrate.
  kubectl -n agent-sandbox rollout status deployment/agent-shared-db --timeout=180s
  kubectl -n agent-sandbox wait --for=condition=complete job \
    -l app.kubernetes.io/name=agent-db-migrate --timeout=300s
  kubectl -n agent-sandbox wait --for=condition=complete job \
    -l app.kubernetes.io/name=agent-postgres-init --timeout=120s
  # podCap=1 lands each conversation on a different pod so per-pod-view bugs are
  # visible; AGENT_HOST_MIN_REPLICAS because the controller is the autoscaler and
  # would otherwise scale the fleet back down before the tests create anything.
  kubectl -n agent-sandbox set env deployment/conversation-controller \
    CONVERSATION_POD_CAP=1 AGENT_HOST_MIN_REPLICAS=3
  kubectl -n agent-sandbox scale deployment/agent-host --replicas=3
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/agent-host --timeout=300s
  kubectl -n agent-sandbox rollout status deployment/conversation-router --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
"
