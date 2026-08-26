# kubenix-agent-manager task runner.
# `just` with no args lists recipes. See docs/TESTING.md for the test strategy.

# Cluster provider for Tier 2/3 (existing | k3s | kind | minikube | k3d)
cluster_provider := env_var_or_default("CLUSTER_PROVIDER", "k3s")

default:
    @just --list

# --- Build -----------------------------------------------------------------

# Evaluate the flake structure (fast; does not build derivations).
check-flake:
    nix flake show

# Render the example platform config (examples/kubenix-config.nix) and assert
# the expected resources are present. Catches (a) Nix syntax / module eval
# errors and (b) silent resource drops — e.g. a shallow `//` that overwrites
# `deployments` and loses agent-host (a valid-but-wrong manifest set a plain
# build wouldn't catch). examples/kubenix-config.nix also doubles as the
# reference config for deploying the platform.
check-manifests:
    @nix eval --impure --raw -f examples/check.nix

# Build the generic Nix sandbox image.
build-image:
    nix build .#sandbox-image

# Build the agent-host and UI.
build-app:
    nix build .#agentHost .#ui

build: build-image build-app

# Measure every shipped image's size as JSON (tarball file size for the sandbox-os
# images; nix2container closure size for the rest). The CI image-size benchmark uses
# this; run it locally to see current sizes or produce a baseline to diff against.
image-sizes *images:
    ./scripts/image-sizes.sh {{images}}

# Diff two image-sizes.json files and render the markdown report (the CI PR comment).
#   just image-sizes > pr.json ; git stash ; just image-sizes > base.json ; git stash pop
#   just image-sizes-diff base.json pr.json
image-sizes-diff base pr flag="5":
    ./scripts/image-sizes-diff.sh {{base}} {{pr}} {{flag}}

# --- Test tiers ------------------------------------------------------------

# Tier 1 — fast contract tests (no cluster, no network). Run this constantly.
test-unit:
    npm install
    npm test

# Tier 2 — ALL cluster tests against real Kubernetes (provision, suspend/resume,
# broker IRSA, webhooks spawn). Per-test names print (verbose reporter).
test-cluster: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 RUN_WEBHOOKS_TESTS=1 \
      CLUSTER_PROVIDER={{cluster_provider}} \
      BROKER_NS=agent-sandbox PLATFORM_NS=agent-sandbox \
      npm run test:cluster

# Tier 3 — Playwright E2E through the UI (fake ACP agent).
test-e2e:
    npm run test:e2e

# Tier 3 — a TARGETED subset for the inner loop (`just e2e <spec>`; never --workers).
e2e *ARGS:
    #!/usr/bin/env bash
    # The full suite is ~25 min; one spec file is under a minute.
    #
    #   just e2e                          # everything
    #   just e2e test/e2e/stop-run.spec.ts
    #   just e2e test/e2e/a.spec.ts test/e2e/b.spec.ts
    #   just e2e -g "queueing keeps thread"
    #
    # NEVER pass --workers. The suite shares ONE agent-host and its conversation
    # state, so parallel workers interleave and the run reports green while testing
    # nothing coherent — that produced a false "111 passed" locally against four
    # failing CI shards. playwright.config.ts pins workers:1 for this reason; a CLI
    # flag overrides it silently, so this rejects it rather than trusting memory.
    #
    # A green subset is NOT evidence the branch is green — run `just test-e2e` or
    # let CI do it before saying so.
    set -euo pipefail
    if [[ " {{ARGS}} " == *" --workers"* ]]; then
      echo "error: --workers breaks this suite (shared agent-host state). See the comment in justfile." >&2
      exit 1
    fi
    npx playwright test --project=chromium {{ARGS}}

# Tier 3 — E2E against a LIVE deployment (real sandbox, real exec, real Bedrock).
# Usage: just test-e2e-external https://chat.example.com [user:pass]
# Drives the deployed agent-host API directly; catches in-cluster failures the
# fake stack can't (e.g. a 403 on pods/exec, broker git auth).
test-e2e-external url basic_auth="":
    RUN_EXTERNAL_E2E=1 AGENT_HOST_URL={{url}} EXTERNAL_BASIC_AUTH={{basic_auth}} \
      npx playwright test test/e2e/external.spec.ts --reporter=list

# Tier 3 — the single real-`goose acp` E2E (needs a model key).
test-e2e-real:
    RUN_REAL_GOOSE=1 npm run test:e2e -- real-goose

# Just the broker IRSA cluster tests.
test-broker: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 BROKER_NS=agent-sandbox \
      CLUSTER_PROVIDER={{cluster_provider}} npm run test:cluster -- broker

# THE full suite — run this to confirm everything works.
# Tier 1 always; Tier 2 + Tier 3 require a cluster (started by their recipes).
test: test-unit test-cluster test-e2e
    @echo "✅ all tiers passed"

# Fast inner loop: just the unit tier.
test-quick: test-unit

# --- Local cluster ---------------------------------------------------------

# Bring up a local cluster + install the agent-sandbox controller, load images.
cluster-up:
    ./test/support/cluster-up.sh {{cluster_provider}}

# Tear down the local cluster.
cluster-down:
    ./test/support/cluster-down.sh {{cluster_provider}}


# --- Cluster-fidelity browser tests (the "tier 2" Playwright project) ------
#
# The browser against a REAL cluster — the seam nothing else covers: test/cluster
# is curl-only (no UI) and the default e2e suite never sees a real server.
#
#   just cluster-platform     # build + import images, apply the platform
#   just e2e-cluster          # run the cluster-project specs against it
#   just e2e-cluster -g "..."  # …or a subset
#
# Teardown is `just cluster-down`. These are deliberately separate steps: bringing
# the platform up costs minutes, and you want to iterate on the specs without
# paying it every time.

# Build + import every platform image into the local cluster, then apply the manifests.
cluster-platform: cluster-up
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh): a shell whose ~/.kube/config
    # points at a stale k3s cluster would otherwise talk to the WRONG cluster, and the
    # error ("failed to download openapi") never mentions kubeconfig.
    export KUBECONFIG="${KUBECONFIG_OVERRIDE:-${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}}"
    [ -s "$KUBECONFIG" ] || export KUBECONFIG="${HOME}/.kube/config"
    for img in \
      "agent-host-image=agent-host:latest" \
      "sandbox-os-image=agent-sandbox-os:latest" \
      "conversation-controller-image=conversation-controller:latest" \
      "conversation-router-image=conversation-router:latest" \
      "broker-image=agent-broker:latest" \
      "webhooks-image=agent-webhooks:latest" \
      "ui-image=agent-sandbox-ui:latest"; do
      attr="${img%%=*}"; name="${img#*=}"
      echo "==> $name"
      nix run ".#${attr}.copyTo" -- "docker-daemon:${name}"
    done
    k3d image import agent-host:latest agent-sandbox-os:latest \
      conversation-controller:latest conversation-router:latest agent-broker:latest \
      agent-webhooks:latest agent-sandbox-ui:latest -c {{_K3D_CLUSTER}}
    kubectl apply -f "$(nix build .#platform-manifests --no-link --print-out-paths)"
    # Match CI: podCap=1 + 3 replicas so conversations SPREAD across pods. With the
    # default topology every test conversation lands on one pod and any per-pod-view
    # bug is invisible — which is how "GET /conversations returns one pod's slice"
    # reached production.
    kubectl -n agent-sandbox set env deployment/conversation-controller CONVERSATION_POD_CAP=1
    kubectl -n agent-sandbox scale deployment/agent-host --replicas=3
    for d in conversation-controller agent-host conversation-router ui; do
      kubectl -n agent-sandbox rollout status "deployment/$d" --timeout=300s
    done
    kubectl -n agent-sandbox annotate deployment/ui "scooter.dev/fingerprint=$(just _fingerprint)" --overwrite >/dev/null
    echo "platform up — now run: just e2e-cluster"


# Which images the local platform runs, and how to fingerprint them. The tag is
# always :latest, so it tells you NOTHING about staleness — but the nix DERIVATION
# path is content-addressed and evaluates in well under a second without building.
# Stored on the deployment as an annotation at deploy time, compared on every run.
# cluster-up.sh names the cluster; keep these in ONE place or a local run targets a
# cluster that does not exist (CI's is scooter-ci, cluster-up.sh's is agent-sandbox).
_K3D_CLUSTER := env_var_or_default("K3D_CLUSTER", "agent-sandbox")

_PLATFORM_IMAGES := "agent-host-image=agent-host conversation-controller-image=conversation-controller conversation-router-image=conversation-router broker-image=agent-broker webhooks-image=agent-webhooks ui-image=agent-sandbox-ui"

# Print the content fingerprint of every platform image (cheap: eval, no build).
[private]
_fingerprint:
    #!/usr/bin/env bash
    set -euo pipefail
    for pair in {{_PLATFORM_IMAGES}}; do
      attr="${pair%%=*}"
      printf '%s=%s\n' "$attr" "$(nix eval --raw ".#${attr}.drvPath" 2>/dev/null | xargs basename)"
    done

# Rebuild + reload ONLY the platform images whose source changed, then restart them.
cluster-redeploy:
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh): a shell whose ~/.kube/config
    # points at a stale k3s cluster would otherwise talk to the WRONG cluster, and the
    # error ("failed to download openapi") never mentions kubeconfig.
    export KUBECONFIG="${KUBECONFIG_OVERRIDE:-${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}}"
    [ -s "$KUBECONFIG" ] || export KUBECONFIG="${HOME}/.kube/config"
    kubectl -n agent-sandbox get deployment/ui >/dev/null 2>&1 || {
      echo "no platform in the cluster — run: just cluster-platform" >&2; exit 1; }
    want=$(just _fingerprint)
    have=$(kubectl -n agent-sandbox get deployment/ui -o jsonpath='{.metadata.annotations.scooter\.dev/fingerprint}' 2>/dev/null || true)
    changed=()
    while IFS='=' read -r attr fp; do
      [ -z "$attr" ] && continue
      grep -qxF "$attr=$fp" <<<"$have" || changed+=("$attr")
    done <<<"$want"
    if [ ${#changed[@]} -eq 0 ]; then echo "cluster is up to date"; exit 0; fi
    echo "rebuilding: ${changed[*]}"
    names=()
    for pair in {{_PLATFORM_IMAGES}}; do
      attr="${pair%%=*}"; name="${pair#*=}"
      for c in "${changed[@]}"; do
        [ "$c" = "$attr" ] || continue
        nix run ".#${attr}.copyTo" -- "docker-daemon:${name}:latest"
        names+=("${name}:latest")
      done
    done
    k3d image import "${names[@]}" -c {{_K3D_CLUSTER}}
    # imagePullPolicy is IfNotPresent on side-loaded images, so a restart is what
    # actually picks up the new layers — `set image` would be a no-op at :latest.
    for pair in {{_PLATFORM_IMAGES}}; do
      name="${pair#*=}"
      dep=$(kubectl -n agent-sandbox get deploy -o name 2>/dev/null | grep -E "/(${name}|${name#agent-})$" || true)
      [ -n "$dep" ] && kubectl -n agent-sandbox rollout restart "$dep" || true
    done
    kubectl -n agent-sandbox annotate deployment/ui "scooter.dev/fingerprint=$want" --overwrite >/dev/null
    for pair in {{_PLATFORM_IMAGES}}; do
      name="${pair#*=}"
      dep=$(kubectl -n agent-sandbox get deploy -o name 2>/dev/null | grep -E "/(${name}|${name#agent-})$" || true)
      [ -n "$dep" ] && kubectl -n agent-sandbox rollout status "$dep" --timeout=300s || true
    done
    echo "redeployed"
# Run the cluster-project specs against the local platform (port-forwards the UI).
e2e-cluster *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh): a shell whose ~/.kube/config
    # points at a stale k3s cluster would otherwise talk to the WRONG cluster, and the
    # error ("failed to download openapi") never mentions kubeconfig.
    export KUBECONFIG="${KUBECONFIG_OVERRIDE:-${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}}"
    [ -s "$KUBECONFIG" ] || export KUBECONFIG="${HOME}/.kube/config"
    kubectl -n agent-sandbox get deployment/ui >/dev/null 2>&1 || {
      echo "no platform in the cluster — run: just cluster-platform" >&2; exit 1; }
    # STALENESS. A cluster running old images reports green while testing code you did
    # not write — the same trap as a reused dev server serving a stale build, which cost
    # a long debugging detour once (see playwright.config.ts). Cheap to check: the nix
    # derivation path is content-addressed and evaluates in under a second.
    want=$(just _fingerprint)
    have=$(kubectl -n agent-sandbox get deployment/ui -o jsonpath='{.metadata.annotations.scooter\.dev/fingerprint}' 2>/dev/null || true)
    if [ "$want" != "$have" ]; then
      echo "" >&2
      if [ -z "$have" ]; then
        echo "WARNING: this cluster was deployed before fingerprinting existed." >&2
        echo "         It may be running stale images. Run: just cluster-redeploy" >&2
      else
        echo "WARNING: the cluster is running STALE images — these have changed:" >&2
        while IFS='=' read -r attr fp; do
          [ -z "$attr" ] && continue
          grep -qxF "$attr=$fp" <<<"$have" || echo "           $attr" >&2
        done <<<"$want"
        echo "         Results will reflect the OLD code. Run: just cluster-redeploy" >&2
      fi
      echo "" >&2
      [ "${E2E_ALLOW_STALE:-}" = "1" ] || { echo "refusing to run (E2E_ALLOW_STALE=1 to override)" >&2; exit 1; }
    fi
    kubectl -n agent-sandbox port-forward svc/ui 8899:8080 >/tmp/scooter-pf.log 2>&1 &
    PF=$!
    trap 'kill "$PF" 2>/dev/null || true' EXIT
    # Wait on a real GET, not the port bind: the forward accepts before nginx serves.
    for i in $(seq 1 60); do
      curl -sf -o /dev/null http://127.0.0.1:8899/ && break
      sleep 1
    done
    curl -sf -o /dev/null http://127.0.0.1:8899/ || {
      echo "the UI never served:" >&2; cat /tmp/scooter-pf.log >&2; exit 1; }
    E2E_TIER=2 E2E_CLUSTER_URL=http://127.0.0.1:8899 \
      npx playwright test --project=cluster {{ARGS}}
# --- Quality ---------------------------------------------------------------

typecheck:
    npm install
    # agent-host imports @scooter/claude-sdk-provider AND @scooter/marimo-mcp; build
    # them first so their dist/ (types + js) exist for agent-host's NodeNext
    # resolution. (Nix builds each separately; this is the plain-npm/CI path.)
    npm -w services/claude-sdk-provider run build
    npm -w services/marimo-mcp run build
    npm -w services/agent-host run typecheck
    npm -w ui run typecheck

lint: typecheck

# Guard against a stale/drifted package-lock.json. Regenerates the lockfiles
# (package-lock-only, no install) and fails if anything changes — i.e. a
# package.json dep was added/bumped without committing the matching lockfile
# (the exact "react-icons added to ui/ but root lockfile never regenerated ->
# floated to a version that dropped an icon" bug). Run with the flake's npm so
# the result is reproducible. THREE lockfiles: root (workspace, used by `just ci`)
# + ui/ and services/agent-host/ (the STANDALONE ones the `nix build .#ui` /
# `.#agentHost` images use via buildNpmPackage — regen with --workspaces=false).
check-lockfiles:
    npm install --package-lock-only --workspaces --include-workspace-root
    npm install --package-lock-only --prefix ui --workspaces=false
    npm install --package-lock-only --prefix services/agent-host --workspaces=false
    @git diff --exit-code -- package-lock.json ui/package-lock.json services/agent-host/package-lock.json \
      || (echo "❌ lockfile drift: a package.json changed without regenerating the lockfile. Run 'nix develop -c just check-lockfiles' and commit the result." && exit 1)
    @echo "✅ lockfiles are in sync with package.json"

# Guard against a stale npmDepsHash. check-lockfiles proves the lockfile matches
# package.json, but NOTHING proved the buildNpmPackage `npmDepsHash` in ui/ and
# services/agent-host/ default.nix matches the lockfile — so a dep bump could land
# with a stale hash and only fail later at `nix build .#ui`/`.#agentHost` (image
# build), AFTER merge. This recomputes each hash from its lockfile (prefetch-npm-
# deps — cheap, no full build) and fails if the committed one differs.
check-npm-hashes:
    #!/usr/bin/env bash
    set -euo pipefail
    fail=0
    check() {  # <lockfile> <nixfile>
      want=$(nix run nixpkgs#prefetch-npm-deps -- "$1" 2>/dev/null)
      have=$(grep -oE 'npmDepsHash = "[^"]+"' "$2" | sed -E 's/.*"([^"]+)".*/\1/')
      if [ "$want" != "$have" ]; then
        echo "❌ stale npmDepsHash in $2: have $have, want $want (from $1)."
        echo "   Fix: set npmDepsHash to the 'want' value above and commit."
        fail=1
      fi
    }
    check ui/package-lock.json ui/default.nix
    check services/agent-host/package-lock.json services/agent-host/default.nix
    [ "$fail" -eq 0 ] && echo "✅ npmDepsHash values match their lockfiles"
    exit "$fail"

# Everything CI runs.
# Every image a MODULE tells a deploy to pull must be published, and every published image
# must be size-benchmarked. Four controllers shipped with ZERO ghcr tags — an ImagePullBackOff
# for any ghcr-based deploy — because nothing compared those lists.
check-image-coverage:
    @scripts/check-image-coverage.sh

ci: check-flake check-manifests check-image-coverage check-lockfiles check-npm-hashes lint test-unit
    @echo "✅ ci (fast) passed — run `just test` for cluster + e2e tiers"

# Build + serve the docs site locally (mkdocs + the GENERATED kubenix option pages).
docs:
    nix build .#options-doc -o /tmp/scooter-options-doc
    SCOOTER_OPTIONS_JSON=/tmp/scooter-options-doc/share/doc/nixos/options.json \
      python3 docs/gen_options.py
    nix shell --impure --expr 'with import <nixpkgs> {}; python3.withPackages (p: [ p.mkdocs p.mkdocs-material p.mkdocs-awesome-pages-plugin ])' \
      --command mkdocs serve
