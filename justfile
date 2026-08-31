# kubenix-agent-manager task runner.
# `just` with no args lists recipes. See docs/TESTING.md for the test strategy.

# Cluster provider for the cluster suites (existing | k3s | kind | minikube | k3d)
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

# unit — fast contract tests against fakes (no cluster, no network). Run this constantly.
test-unit:
    npm install
    npm test

# cluster integration (vitest) — against real Kubernetes (provision, suspend/resume,
# broker IRSA, webhooks spawn). Per-test names print (verbose reporter).
test-cluster: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 RUN_WEBHOOKS_TESTS=1 \
      CLUSTER_PROVIDER={{cluster_provider}} \
      BROKER_NS=agent-sandbox PLATFORM_NS=agent-sandbox \
      npm run test:cluster

# e2e fast — Playwright through the real UI + real agent-host; agent + cluster faked.
test-e2e:
    npm run test:e2e

# e2e fast — a TARGETED subset for the inner loop (`just e2e <spec>`; never --workers).
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
    npx playwright test --project=fast {{ARGS}}

# e2e external — against a LIVE deployment (real sandbox, real exec, real Bedrock).
# Usage: just test-e2e-external https://chat.example.com [user:pass]
# Drives the deployed agent-host API directly; catches in-cluster failures the
# fake stack can't (e.g. a 403 on pods/exec, broker git auth).
test-e2e-external url basic_auth="":
    RUN_EXTERNAL_E2E=1 AGENT_HOST_URL={{url}} EXTERNAL_BASIC_AUTH={{basic_auth}} \
      npx playwright test test/e2e/external.spec.ts --reporter=list

# e2e real-agent — the single real-`goose acp` E2E (needs a model key).
test-e2e-real:
    RUN_REAL_GOOSE=1 npm run test:e2e -- real-goose

# --- Randomized test order (flake detection) -------------------------------
# Test order randomization surfaces ordering-dependent flakes that pass when run
# in one order but fail in another. Set a seed to make a failing run reproducible.

# unit tests with randomized order. Pass TEST_SEED=<number> to reproduce a run.
test-unit-randomized seed="":
    #!/usr/bin/env bash
    set -euo pipefail
    SEED="${TEST_SEED:-{{seed}}}"
    [ -z "$SEED" ] && SEED=$(date +%s)
    echo "🎲 Running unit tests with randomized order (seed: $SEED)"
    echo "   Reproduce with: just test-unit-randomized $SEED"
    echo "   Or: TEST_SEED=$SEED just test-unit-randomized"
    echo ""
    TEST_RANDOMIZE=1 TEST_SEED="$SEED" npm test

# e2e tests with randomized file order. Pass E2E_SEED=<number> to reproduce a run.
test-e2e-randomized *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # Same --workers guard as the normal e2e recipe.
    if [[ " {{ARGS}} " == *" --workers"* ]]; then
      echo "error: --workers breaks this suite (shared agent-host state). See the comment in justfile." >&2
      exit 1
    fi
    node scripts/run-e2e-randomized.mjs {{ARGS}}

# cluster tests with randomized order. Pass TEST_SEED=<number> to reproduce a run.
test-cluster-randomized seed="": cluster-up
    #!/usr/bin/env bash
    set -euo pipefail
    SEED="${TEST_SEED:-{{seed}}}"
    [ -z "$SEED" ] && SEED=$(date +%s)
    echo "🎲 Running cluster tests with randomized order (seed: $SEED)"
    echo "   Reproduce with: just test-cluster-randomized $SEED"
    echo "   Or: TEST_SEED=$SEED just test-cluster-randomized"
    echo ""
    TEST_RANDOMIZE=1 TEST_SEED="$SEED" \
      RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 RUN_WEBHOOKS_TESTS=1 \
      CLUSTER_PROVIDER={{cluster_provider}} \
      BROKER_NS=agent-sandbox PLATFORM_NS=agent-sandbox \
      npm run test:cluster

# Just the broker IRSA cluster tests.
test-broker: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 BROKER_NS=agent-sandbox \
      CLUSTER_PROVIDER={{cluster_provider}} npm run test:cluster -- broker

# THE full suite — run this to confirm everything works.
# unit always; the cluster + e2e suites need their servers (started by their recipes).
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
#   just e2e-full             # run the full-target specs against it
#   just e2e-full -g "..."     # …or a subset
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
      attr="${img%%=*}"; name="${img#*=}"; name="${name%%:*}"
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
    echo "platform up — now run: just e2e-full"


# Which images the local platform runs, and how to fingerprint them. The tag is
# always :latest, so it tells you NOTHING about staleness — but the nix DERIVATION
# path is content-addressed and evaluates in well under a second without building.
# Stored on the deployment as an annotation at deploy time, compared on every run.
# cluster-up.sh names the cluster; keep these in ONE place or a local run targets a
# cluster that does not exist (CI's is scooter-ci, cluster-up.sh's is agent-sandbox).
_K3D_CLUSTER := env_var_or_default("K3D_CLUSTER", "agent-sandbox")

# attr=image:deployment. The DEPLOYMENT is named explicitly because deriving it from the
# image name silently failed: agent-sandbox-ui strips to "sandbox-ui" but the deployment is
# "ui", so `ui` was rebuilt and imported and then NEVER RESTARTED — the cluster served a
# 5-hour-old bundle while the fingerprint reported current, and several conclusions were
# drawn against stale code before anyone checked the served asset.
_PLATFORM_IMAGES := "agent-host-image=agent-host:agent-host conversation-controller-image=conversation-controller:conversation-controller conversation-router-image=conversation-router:conversation-router broker-image=agent-broker:agent-broker webhooks-image=agent-webhooks:agent-webhooks ui-image=agent-sandbox-ui:ui"

# Print the content fingerprint of every platform image (cheap: eval, no build).
[private]
_fingerprint:
    #!/usr/bin/env bash
    set -euo pipefail
    for pair in {{_PLATFORM_IMAGES}}; do
      attr="${pair%%=*}"
      printf '%s=%s\n' "$attr" "$(nix eval --raw ".#${attr}.drvPath" 2>/dev/null | xargs basename)"
    done
    # The MANIFESTS too — a CRD schema change is invisible to the image fingerprints, and
    # the apiserver PRUNES fields the live CRD does not know: creatorPod was silently
    # stripped from every patch while all images read "current". Third deployed≠current
    # incident; the fingerprint now covers everything the platform is made of.
    printf 'platform-manifests=%s\n' "$(nix eval --raw ".#platform-manifests.drvPath" 2>/dev/null | xargs basename)"

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
    for c in "${changed[@]}"; do
      if [ "$c" = "platform-manifests" ]; then
        echo "==> manifests changed — applying (CRDs/RBAC/env are not in any image)"
        kubectl apply -f "$(nix build .#platform-manifests --no-link --print-out-paths)"
      fi
    done
    names=()
    for pair in {{_PLATFORM_IMAGES}}; do
      attr="${pair%%=*}"; rest="${pair#*=}"; name="${rest%%:*}"
      for c in "${changed[@]}"; do
        [ "$c" = "$attr" ] || continue
        nix run ".#${attr}.copyTo" -- "docker-daemon:${name}:latest"
        names+=("${name}:latest")
      done
    done
    # A manifests-only drift rebuilds no images; k3d fatals on zero args.
    [ ${#names[@]} -gt 0 ] && k3d image import "${names[@]}" -c {{_K3D_CLUSTER}}
    # imagePullPolicy is IfNotPresent on side-loaded images, so a restart is what
    # actually picks up the new layers — `set image` would be a no-op at :latest.
    for pair in {{_PLATFORM_IMAGES}}; do
      rest="${pair#*=}"; dep="deployment/${rest#*:}"
      kubectl -n agent-sandbox rollout restart "$dep" >/dev/null || true
    done
    for pair in {{_PLATFORM_IMAGES}}; do
      rest="${pair#*=}"; dep="deployment/${rest#*:}"
      kubectl -n agent-sandbox rollout status "$dep" --timeout=300s >/dev/null || true
    done
    # STAMP ONLY AFTER THE ROLLOUTS SUCCEED. Stamping first meant a redeploy that failed
    # to restart anything still reported "current", and the guard then cleared a stale
    # cluster to run — which is exactly how a 5-hour-old UI bundle passed as fresh.
    kubectl -n agent-sandbox annotate deployment/ui "scooter.dev/fingerprint=$want" --overwrite >/dev/null
    echo "redeployed"
# Run the cluster-project specs against the local platform (port-forwards the UI).
alias e2e-cluster := e2e-full

e2e-full *ARGS:
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
    # PERSIST THE RUN. A cluster run costs minutes, so re-running it just to grep a
    # different line out of output you already had is pure waste. Everything lands in
    # .e2e-cluster/ — the full log, plus the agent-host/controller/router logs from the
    # same window, so a failure can be investigated WITHOUT reproducing it.
    out=".e2e-cluster"
    # WIPE FIRST. Pods change name on every redeploy, so without this the directory
    # accumulates logs from every ReplicaSet ever run and a grep sums across all of
    # history — an identical error count across three runs looked like a live bug and
    # was entirely stale files. The artifacts must describe THIS run only.
    rm -rf "$out"
    mkdir -p "$out"
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    set +e
    E2E_TARGET=full E2E_CLUSTER_URL=http://127.0.0.1:8899 \
      npx playwright test --project=full {{ARGS}} 2>&1 | tee "$out/run.log"
    rc=${PIPESTATUS[0]}
    set -e
    # EVERY pod in the namespace, whole log, both containers, plus the PREVIOUS
    # container when one restarted (a crash-looped pod's real error is only there).
    # --since-time scopes each pod's log to this run; the wipe above handles pods that
    # no longer exist. Both are needed: one bounds time, the other bounds which pods.
    mkdir -p "$out/pods"
    for pod in $(kubectl -n agent-sandbox get pods -o name 2>/dev/null); do
      name="${pod#pod/}"
      # SINCE THE RUN STARTED. Without this, `logs` returns each pod's whole history and
      # stale failures from earlier runs read as current — which sent one investigation
      # down a dead end (an identical 1201-error count across two runs was old data).
      # The full history is still available via kubectl when genuinely wanted.
      kubectl -n agent-sandbox logs "$pod" --since-time="$started" --tail=-1 --prefix \
        --all-containers >"$out/pods/$name.log" 2>&1 || true
      kubectl -n agent-sandbox logs "$pod" --tail=-1 --all-containers --previous \
        >"$out/pods/$name.previous.log" 2>/dev/null || rm -f "$out/pods/$name.previous.log"
    done
    # Cluster state a log alone cannot explain: what exists, what is wedged, and why.
    kubectl -n agent-sandbox get pods,deploy,svc,conversations -o wide >"$out/state.txt" 2>&1 || true
    kubectl -n agent-sandbox get conversations -o yaml >"$out/conversations.yaml" 2>&1 || true
    kubectl -n agent-sandbox get events --sort-by=.lastTimestamp >"$out/events.txt" 2>&1 || true
    kubectl -n agent-sandbox describe pods >"$out/describe-pods.txt" 2>&1 || true
    # The NODE's view: allocatable vs requested (the "Allocated resources" table) and
    # taints/conditions. A sandbox Pending on Insufficient cpu is invisible in pod
    # logs — only this shows the node had nothing left to give.
    kubectl describe nodes >"$out/node.txt" 2>&1 || true
    kubectl get sandboxes.agents.x-k8s.io -n agent-sandbox -o yaml >"$out/sandboxes.yaml" 2>&1 || true
    echo ""
    echo "logs: $out/  (run.log, pods/*.log, state.txt, events.txt, conversations.yaml, describe-pods.txt, node.txt, sandboxes.yaml)"
    du -sh "$out" 2>/dev/null | awk '{print "      total: "$1}'
    exit "$rc"
# --- Quality ---------------------------------------------------------------

typecheck:
    npm install
    # agent-host imports @scooter/claude-sdk-provider, @scooter/marimo-mcp AND
    # @scooter/schema; build them first so their dist/ (types + js) exist for
    # agent-host's NodeNext resolution. (Nix builds each separately; this is the
    # plain-npm/CI path.)
    npm -w services/claude-sdk-provider run build
    npm -w services/marimo-mcp run build
    npm -w @scooter/schema run build
    npm -w services/agent-host run typecheck
    npm -w ui run typecheck
    # The generated Drizzle schema (catches broken/drifted generation at the type level).
    npm -w @scooter/schema run typecheck

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
    npm install --package-lock-only --prefix services/byoc-controller --workspaces=false
    npm install --package-lock-only --prefix lib/ts/scooter-schema --workspaces=false
    @git diff --exit-code -- package-lock.json ui/package-lock.json services/agent-host/package-lock.json services/byoc-controller/package-lock.json lib/ts/scooter-schema/package-lock.json \
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
    check services/byoc-controller/package-lock.json services/byoc-controller/default.nix
    check lib/ts/scooter-schema/package-lock.json lib/ts/scooter-schema/default.nix
    [ "$fail" -eq 0 ] && echo "✅ npmDepsHash values match their lockfiles"
    exit "$fail"

# Everything CI runs.
# Every image a MODULE tells a deploy to pull must be published, and every published image
# must be size-benchmarked. Four controllers shipped with ZERO ghcr tags — an ImagePullBackOff
# for any ghcr-based deploy — because nothing compared those lists.
check-image-coverage:
    @scripts/check-image-coverage.sh

# --- Database schema (Atlas) ------------------------------------------------
# The shared Postgres schema is declared in lib/sql/<db>/schema.sql (one env per
# per-service database). Atlas owns the migrations under lib/sql/<db>/migrations,
# computed from schema.sql. Each recipe spins its own EPHEMERAL local Postgres as
# Atlas's dev database (scripts/atlas-dev.sh) so nothing is shared.
db_envs := "webhooks scheduler broker byoc agent_host"

# Regenerate the per-language ORM bindings (@scooter/schema, scooter_schema) from
# lib/sql/<db>/schema.sql. Uses embedded pglite only — no server. Commit the result.
db-generate:
    scripts/db-generate.sh

# CI drift guard: regenerate the bindings and fail if the committed output differs —
# a schema change that forgets to regenerate fails the build (like check-lockfiles).
db-generate-check:
    scripts/db-generate.sh
    @git diff --exit-code -- lib/ts/scooter-schema/src lib/py/scooter-schema/src \
      || (echo "❌ generated schema drift: lib/sql changed without regenerating. Run 'nix develop -c just db-generate' and commit the result." && exit 1)
    @echo "✅ generated ORM bindings are in sync with lib/sql"

# Author migrations from schema.sql for every database. Only databases whose
# schema actually changed get a new file. Usage: just db-migrate <name>
db-migrate name:
    #!/usr/bin/env bash
    set -euo pipefail
    for env in {{db_envs}}; do
      echo "== $env =="
      scripts/atlas-dev.sh migrate diff {{name}} --env "$env"
    done

# Validate every database's migration directory (order, checksums, replayability).
db-validate:
    #!/usr/bin/env bash
    set -euo pipefail
    for env in {{db_envs}}; do
      echo "== $env =="
      scripts/atlas-dev.sh migrate validate --env "$env"
    done

ci: check-flake check-manifests check-image-coverage check-lockfiles check-npm-hashes lint db-generate-check test-unit
    @echo "✅ ci (fast) passed — run `just test` for cluster + e2e tiers"

# Build + serve the docs site locally (mkdocs + the GENERATED kubenix option pages).
docs:
    nix build .#options-doc -o /tmp/scooter-options-doc
    SCOOTER_OPTIONS_JSON=/tmp/scooter-options-doc/share/doc/nixos/options.json \
      python3 docs/gen_options.py
    nix shell --impure --expr 'with import <nixpkgs> {}; python3.withPackages (p: [ p.mkdocs p.mkdocs-material p.mkdocs-awesome-pages-plugin ])' \
      --command mkdocs serve
