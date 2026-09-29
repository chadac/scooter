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

# --- phase timing ------------------------------------------------------------
# This script is the bulk of an e2e shard's wall clock (~7 of ~12 min), but
# which PART was never measured -- the image push, the cluster boot, and the
# platform rollout were all guesses. `phase` stamps each boundary and the trap
# prints a breakdown at exit, so the next optimisation targets whatever is
# actually slow rather than whatever looks slow.
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

phase "cluster+registry"
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
  # PERSIST THE BLOB STORE when the runner provides one (self-hosted: the cache
  # volume bind-mounts /var/lib/k3d-registry). k3d registry create makes a fresh
  # container every run, so without this skopeo re-uploads all eight images into
  # an empty registry -- measured at 103s, the largest single item in this
  # script. The push already skips layers "already present"; this is what makes
  # any be present. On a GitHub-hosted runner the directory does not exist and
  # the registry is ephemeral exactly as before.
  reg_vol=""
  [ -d /var/lib/k3d-registry ] && reg_vol="-v /var/lib/k3d-registry:/var/lib/registry"

  # PERSIST THE NODE CONTENT STORE for the same reason, but for the images we do
  # NOT build: postgres:16-alpine, alpine/k8s:1.30.0, busybox:1.36. Those are
  # pulled from Docker Hub by containerd inside the node, and the node is fresh
  # every run, so they download every time. postgres:16-alpine measured 45s for
  # 201M and gates the whole rollout -- postgres-init waits on it for roles,
  # db-migrate for schema, every service on both.
  #
  # Verified across node recreation and a k3s version change (1.32.5 -> 1.30.2):
  # no snapshot corruption, and a pod with the default IfNotPresent policy logs
  # "already present on machine" and starts in ~1s without any network call.
  #
  # Same shape as reg_vol: absent directory (GitHub-hosted) means no flag and
  # the old cold-pull behaviour.
  ctd_vol=""
  [ -d /var/lib/k3d-containerd ] && ctd_vol="-v /var/lib/k3d-containerd:/var/lib/rancher/k3s/agent/containerd"

  # shellcheck disable=SC2086  # intentional word-split: empty means "no flag"
  k3d registry create scooter-reg.localhost --port 5800 $reg_vol
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

phase "platform-images-push"
# --- platform images ---------------------------------------------------------
# attr -> content-tagged registry ref, from the flake (single source of truth with
# the platform-manifests-k3d render). Pushes run 4-wide: skopeo streams layer blobs
# straight from /nix/store, and layers shared between images (there are many — same
# nixpkgs base) upload exactly once.
# Split the push phase: EVALUATING the refs (a nix build, which may itself be
# the slow part) is distinct from PUSHING the blobs. @chadac's hypothesis is
# that the store->registry copy dominates; this tells us whether that is true
# or whether we are actually waiting on nix eval.
_push_eval_t0=$(date +%s)
refs=$(nix build .#k3d-image-refs --no-link --print-out-paths)
echo "[phase] image-refs-eval=$(( $(date +%s) - _push_eval_t0 ))s"

# REALISE ALL EIGHT IMAGE MANIFESTS IN ONE `nix build`, and hand the store paths
# to the push loop. This is what keeps Nix OUT of the parallel section.
#
# The old loop ran `nix run .#<attr>.copyTo` per image under `xargs -P 4`. Four
# Nix processes then opened the SAME eval-cache SQLite file at once; SQLite
# grants one writer, and the other three got
#   error (ignored): SQLite database '.../eval-cache-v5/<hash>.sqlite' is busy
# `error (ignored)` means Nix silently falls back to FULL re-evaluation -- so
# three of every four workers re-instantiated the ~6.4k-derivation graph that
# image-refs-eval had just finished computing. Reproduced locally: 4 concurrent
# evals against one warm cache, 3 lose the lock.
#
# One `nix build` of all eight attrs costs ~0s once image-refs-eval has warmed
# the cache (measured 0.06s locally on the repeat) because it forces the exact
# same graph. After it, every path is realised and the workers need no Nix at
# all -- just skopeo, reading a store path.
#
# `--print-out-paths` emits one path per line IN THE ORDER THE ATTRS ARE GIVEN,
# so the join below is positional. Keep the two lists in the same order.
_push_build_t0=$(date +%s)
push_attrs=(
  agent-host-image
  ui-image
  broker-image
  webhooks-image
  sandbox-os-image
  conversation-controller-image
  conversation-router-image
  db-migrator-image
)
mapfile -t push_paths < <(nix build "${push_attrs[@]/#/.#}" --no-link --print-out-paths)
if [ "${#push_paths[@]}" -ne "${#push_attrs[@]}" ]; then
  echo "ERROR: realised ${#push_paths[@]} image manifests, expected ${#push_attrs[@]}"
  exit 1
fi
echo "[phase] image-manifest-build=$(( $(date +%s) - _push_build_t0 ))s"

# nix2container's PATCHED skopeo -- upstream skopeo has no `nix:` transport and
# fails with `unknown transport "nix"`. `nix run .#<attr>.copyTo` was pulling
# this in implicitly; now it is named, resolved ONCE here rather than per image.
# EXPORTED: the xargs subshells below are separate bash processes and inherit
# only the environment, not shell variables.
export SKOPEO
# `grep -v -- -man`: the derivation is multi-output and --print-out-paths emits
# the man output too; taking head -1 blind picks whichever sorts first.
SKOPEO=$(nix build 'github:nlewo/nix2container#skopeo-nix2container' --no-link --print-out-paths | grep -v -- '-man$' | head -1)/bin/skopeo
if [ ! -x "$SKOPEO" ]; then
  echo "ERROR: could not resolve nix2container's skopeo at '$SKOPEO'"
  exit 1
fi

# REFS map -> a bash array in push_attrs order, in ONE jq call. The refs file is
# attr -> "k3d-scooter-reg.localhost:5800/<name>:<tag>"; jq emits just the values,
# ordered by the attr list, so the three arrays line up by index.
# `--args` AFTER the file, not before: jq treats everything following --args as
# positional, so putting it first makes jq read the filename as an arg and then
# block forever on stdin. (It does exactly that; caught before this shipped.)
mapfile -t push_refs < <(
  nix shell nixpkgs#jq -c jq -r '
      . as $m | $ARGS.positional[] | $m[.]
    ' "$refs" --args "${push_attrs[@]}"
)
if [ "${#push_refs[@]}" -ne "${#push_attrs[@]}" ]; then
  echo "ERROR: resolved ${#push_refs[@]} refs, expected ${#push_attrs[@]}"
  exit 1
fi

_push_copy_t0=$(date +%s)
# attr=storepath=ref per line. Plain printf -- no per-image process at all.
for _i in "${!push_attrs[@]}"; do
  printf '%s=%s=%s\n' "${push_attrs[$_i]}" "${push_paths[$_i]}" "${push_refs[$_i]}"
done \
  | xargs -P 4 -I{} bash -c '
      set -euo pipefail
      # attr=storepath=ref, built above. Splitting on "=" rather than passing
      # three args because xargs -I{} substitutes a single token.
      attr="${1%%=*}"; _rest="${1#*=}"
      img_path="${_rest%%=*}"; ref="${_rest#*=}"
      push_ref="localhost:${ref#*.localhost:}"

      # ALREADY THERE? Tags are content-addressed (ghcrContentTag = the store
      # hash), so a tag that exists in the registry holds exactly the bytes we
      # are about to push. Asking costs one HTTP HEAD against localhost.
      #
      # This is worth more than the blob transfer it avoids. With the registry
      # blob store persisted on the /nix volume, skopeo already skips layers it
      # finds present -- measured 85s -> 42s once tags were stable. The 42s that
      # REMAINED is `nix run` paying Nix evaluation eight times over, once per
      # image, and that cost is the same whether or not a single byte moves.
      # Skipping the command skips the eval too.
      #
      # The registry is the k3d-managed one on 5800; `|| true` because a
      # registry that does not answer must fall through to a real push rather
      # than fail the shard.
      repo="${push_ref#*/}"; repo="${repo%%:*}"
      tag="${push_ref##*:}"
      if curl -sfI -o /dev/null --max-time 5 \
           "http://localhost:5800/v2/${repo}/manifests/${tag}" \
           -H "Accept: application/vnd.oci.image.manifest.v1+json" \
           -H "Accept: application/vnd.docker.distribution.manifest.v2+json" 2>/dev/null; then
        echo "= $attr already in registry at $tag -- skipping push"
        exit 0
      fi

      echo "push $attr -> $ref (via $push_ref)"

      max_retries=3
      retry=0
      while [ $retry -lt $max_retries ]; do
        # skopeo reads the already-realised manifest straight from the store.
        # No `nix run`, so no evaluation and no eval-cache lock to contend on.
        if "$SKOPEO" --insecure-policy copy "nix:${img_path}" \
             "docker://${push_ref}" --dest-tls-verify=false; then
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
manifests=$(nix build .#platform-manifests-k3d --no-link --print-out-paths)
nix shell nixpkgs#kubectl -c bash -c "
  set -euo pipefail
  kubectl apply -f '${manifests}'
  # Postgres accepts TCP before it is USABLE: agent-postgres-init creates the roles
  # (until then callers get 28P01) and agent-db-migrate creates the schema (until then
  # 42P01). Nothing below waits on the database, so every service raced it. Selected by
  # label, not name — both Job names carry a spec hash that changes with the schema.
  kubectl -n agent-sandbox rollout status deployment/agent-shared-db --timeout=180s
  kubectl -n agent-sandbox wait --for=condition=complete job \
    -l app.kubernetes.io/name=agent-postgres-init --timeout=180s
  kubectl -n agent-sandbox wait --for=condition=complete job \
    -l app.kubernetes.io/name=agent-db-migrate --timeout=180s
  # MULTI-REPLICA + SPREAD. The default topology (replicas=2, podCap=100) puts every
  # test conversation on ONE pod, so any per-pod-view bug is invisible — which is
  # exactly how the 'GET /conversations returns one pod's slice' bug reached
  # production. Force podCap=1 so each conversation lands on a DIFFERENT pod, and
  # give the fleet room to spread.
  # AGENT_HOST_MIN_REPLICAS, not just a manual scale: the controller IS the autoscaler and
  # the single writer of agent-host replicas (desired = ceil(demand/cap), clamped to
  # [min,max]). With no conversations yet, demand is 0, so it scaled the fleet straight back
  # down and the spread this suite needs evaporated before the tests created anything.
  kubectl -n agent-sandbox set env deployment/conversation-controller \
    CONVERSATION_POD_CAP=1 AGENT_HOST_MIN_REPLICAS=3
  kubectl -n agent-sandbox scale deployment/agent-host --replicas=3
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/agent-host --timeout=300s
  kubectl -n agent-sandbox rollout status deployment/conversation-router --timeout=180s
  kubectl -n agent-sandbox rollout status deployment/conversation-controller --timeout=180s
"
