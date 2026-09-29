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
# ONE build for everything this script needs from the flake: the refs map, the
# eight image manifests, their copyTo runners, and the k3d platform manifests.
#
# WHY ONE. Each `nix build` is its own evaluation, and in CI each one
# re-evaluates the sandbox-os NixOS system -- the expensive part of this flake.
# The tell is the `stdenv.isLinux is deprecated` warning, which comes from that
# evaluation: it fired 55s into image-refs-eval and AGAIN 24.5s into a separate
# image-manifest-build. The same ~6.4k-derivation instantiation, twice.
#
# This does NOT reproduce locally, where those derivations are already written
# and an "evaluation" is really a lookup (4.6s then 1.0s). A local timing
# under-predicts the CI cost every time; do not use one to judge this.
# BUILD THE IMAGE MANIFESTS LOCALLY, never substitute them.
#
# nix2container image manifests are NOT reproducible across build environments.
# Proven on this repo: the SAME deriver
#   1w4irzhbbhxv6h049g84mr6p4zhyw013-image-agent-sandbox-os.json.drv
# yields two different outputs. The manifest Cachix serves and the one built
# here differ in exactly one layer -- and that layer lists an IDENTICAL set of
# 449 store paths. Same inputs, different tar digest.
#
# The consequence is a shard that dies deep in the push phase:
#   writing blob: ... Digest did not match,
#   expected sha256:fccfa6fa..., got sha256:a3bb524c...
# skopeo streams layers from /nix/store and hashes them, then compares against
# the digest recorded in the FETCHED manifest. Fetched manifest + locally built
# layers = mismatch. Three retries all failed identically, on two separate
# runners, because both had fetched the same cached manifest.
#
# The tag hides it: it is the manifest's own store hash, which IS deterministic,
# so two manifests that disagree about layer digests still share a tag.
#
# Upstream: nlewo/nix2container#97 is this exact symptom ("the store paths are
# NOT different but the hashes are"), closed without a root cause. #37 and #127
# are the same error. No open issue covers it.
#
# Building locally costs one build per volume -- the /nix store is persisted, so
# it is not per-run -- and removes the mismatch by construction: the manifest
# and the layers then come from the same machine.
# SCOPED to the manifests. `--option substituters ''` on the whole build would
# force the ENTIRE closure to build from source -- 51 derivations even on a warm
# store, and effectively all of nixpkgs on a cold one. Instead: delete just the
# image manifests from the store if a substituted copy is present, so the build
# below remakes them locally while everything else still comes from the cache.
for _a in agent-host-image ui-image broker-image webhooks-image sandbox-os-image \
          conversation-controller-image conversation-router-image db-migrator-image; do
  _p=$(nix eval --raw ".#${_a}.outPath" 2>/dev/null) || continue
  [ -n "$_p" ] || continue
  # Only if it came from a SUBSTITUTER. A path we built ourselves is already
  # consistent with the layers we will push.
  #
  # `ultimate` is the discriminator: true when this machine built the path,
  # absent (JSON null) when it was substituted. Checked both ways -- a locally
  # built manifest reports ultimate=true, a cache-fetched one reports null.
  # Testing for "ultimate":false would never match; the field is omitted, not
  # set to false.
  _ult=$(nix path-info --json "$_p" 2>/dev/null | nix shell nixpkgs#jq -c jq -r '.[].ultimate // "null"' 2>/dev/null)
  if [ -e "$_p" ] && [ "$_ult" != "true" ]; then
    nix store delete "$_p" >/dev/null 2>&1 \
      && echo "dropped substituted manifest for $_a (nix2container#97)" \
      || true
  fi
done

deps=$(nix build .#k3d-ci-deps --no-link --print-out-paths)
refs="$deps/image-refs.json"
echo "[phase] image-refs-eval=$(( $(date +%s) - _push_eval_t0 ))s"

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

# EXPORTED for the xargs subshells: they are separate bash processes and
# inherit the environment, not shell variables.
export DEPS="$deps"

_push_copy_t0=$(date +%s)
# attr=storepath=ref per line. Plain printf -- no per-image process at all.
for _i in "${!push_attrs[@]}"; do
  printf '%s=%s\n' "${push_attrs[$_i]}" "${push_refs[$_i]}"
done \
  | xargs -P 4 -I{} bash -c '
      set -euo pipefail
      attr="${1%%=*}"; ref="${1#*=}"
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
        # `nix run .#<attr>.copyTo`, NOT a skopeo we name ourselves. copyTo
        # bundles skopeo 1.24.1 and is SUBSTITUTABLE; the exposed
        # `skopeo-nix2container` attr is a DIFFERENT derivation (1.21.0) that
        # nothing has cached, so naming it costs a source build plus ~139 paths
        # / 203 MiB of fetches. Measured, after trying exactly that.
        #
        # This still evaluates -- but the batched `nix build` above has already
        # realised the graph, so it is a cache hit rather than the ~6.4k-drv
        # re-instantiation that the lock contention used to force.
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
# From the single build at the top of the push phase -- not another `nix build`,
# which would be a third evaluation of the same flake.
manifests="$deps/platform-manifests-k3d.yaml"
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
