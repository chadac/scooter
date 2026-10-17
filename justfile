# Scooter task runner: `just` with no args lists recipes; docs/TESTING.md has the
# test strategy.

# Cluster provider for the cluster suites (existing | k3s | kind | minikube | k3d)
cluster_provider := env_var_or_default("CLUSTER_PROVIDER", "k3s")

default:
    @just --list

# --- Build -----------------------------------------------------------------

# Evaluate the flake structure (fast; does not build derivations).
check-flake:
    nix flake show

# Render the example platform config (examples/kubenix-config.nix) and assert the
# expected resources are present, catching module eval errors and silent resource
# drops.
check-manifests:
    @nix eval --impure --raw -f examples/check.nix

# Build the generic Nix sandbox image.
build-image:
    nix build .#sandbox-image

# Build the agent-host and UI.
build-app:
    nix build .#agentHost .#ui

build: build-image build-app

# Measure every shipped image's size as JSON (nix2container closure size), as the
# CI image-size benchmark does.
image-sizes *images:
    ./scripts/image-sizes.sh {{images}}

# Diff two image-sizes.json files and render the markdown report (the CI PR comment).
image-sizes-diff base pr flag="5":
    ./scripts/image-sizes-diff.sh {{base}} {{pr}} {{flag}}

# --- Test tiers ------------------------------------------------------------

# unit — fast contract tests against fakes (no cluster, no network); run this constantly.
test-unit:
    npm install
    npm test

# cluster integration (vitest) against real Kubernetes: provision, suspend/resume,
# broker IRSA, webhooks spawn.
test-cluster: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 RUN_WEBHOOKS_TESTS=1 \
      CLUSTER_PROVIDER={{cluster_provider}} \
      BROKER_NS=agent-sandbox PLATFORM_NS=agent-sandbox \
      npm run test:cluster

# e2e fast — Playwright through the real UI + real agent-host; agent + cluster faked.
test-e2e:
    npm run test:e2e

# e2e fast — a targeted subset for the inner loop (`just e2e <spec>`; never --workers).
[positional-arguments]
e2e *ARGS:
    #!/usr/bin/env bash
    # One spec file is under a minute; the full suite is ~25 min.
    #
    #   just e2e                          # everything
    #   just e2e test/e2e/stop-run.spec.ts
    #   just e2e test/e2e/a.spec.ts test/e2e/b.spec.ts
    #   just e2e -g "queueing keeps thread"
    #
    # Never pass --workers: the suite shares one agent-host and its conversation
    # state, so parallel workers interleave and the run reports green while testing
    # nothing coherent, and a green subset is not evidence the branch is green.
    # [positional-arguments] + "$@" rather than {{ARGS}}, which just interpolates as
    # text and splits -g "queueing keeps thread" into three argv entries.
    set -euo pipefail
    if [[ " $* " == *" --workers"* ]]; then
      echo "error: --workers breaks this suite (shared agent-host state). See the comment in justfile." >&2
      exit 1
    fi
    npx playwright test --project=fast "$@"

# e2e external — against a live deployment (real sandbox, exec, Bedrock); usage:
# just test-e2e-external https://chat.example.com [user:pass].
test-e2e-external url basic_auth="":
    RUN_EXTERNAL_E2E=1 AGENT_HOST_URL={{url}} EXTERNAL_BASIC_AUTH={{basic_auth}} \
      npx playwright test test/e2e/external.spec.ts --reporter=list

# e2e real-agent — the single real-`goose acp` E2E (needs a model key).
test-e2e-real:
    RUN_REAL_GOOSE=1 npm run test:e2e -- real-goose

# --- Randomized test order (flake detection) -------------------------------
# Randomized test order surfaces ordering-dependent flakes; set a seed to
# reproduce a run.

# unit tests with randomized order; TEST_SEED=<number> reproduces a run.
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

# e2e tests with randomized file order; E2E_SEED=<number> reproduces a run.
[positional-arguments]
test-e2e-randomized *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # Same --workers guard and same "$@" (not {{ARGS}}) quoting as the `e2e` recipe.
    if [[ " $* " == *" --workers"* ]]; then
      echo "error: --workers breaks this suite (shared agent-host state). See the comment in justfile." >&2
      exit 1
    fi
    node scripts/run-e2e-randomized.mjs "$@"

# cluster tests with randomized order; TEST_SEED=<number> reproduces a run.
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

# The full suite: unit, then the cluster and e2e tiers, which start their own servers.
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
# The browser against a real cluster, the seam test/cluster (curl-only) and the
# default e2e suite (no real server) do not cover. `just cluster-platform` builds,
# imports and applies the platform, `just e2e-full [-g ...]` runs the full-target
# specs against it, and `just cluster-down` tears it down; the steps are separate
# because bringing the platform up costs minutes.

# Build + import every platform image into the local cluster, then apply the manifests.
cluster-platform: cluster-up
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh); a stale ~/.kube/config
    # would otherwise point at the wrong cluster.
    export KUBECONFIG="${KUBECONFIG_OVERRIDE:-${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}}"
    [ -s "$KUBECONFIG" ] || export KUBECONFIG="${HOME}/.kube/config"
    for img in \
      "agent-host-image=agent-host:latest" \
      "sandbox-os-image=agent-sandbox-os:latest" \
      "conversation-controller-image=conversation-controller:latest" \
      "conversation-router-image=conversation-router:latest" \
      "broker-image=agent-broker:latest" \
      "webhooks-image=agent-webhooks:latest" \
      "db-migrator-image=agent-db-migrator:latest" \
      "byoc-controller-image=byoc-controller:latest" \
      "ui-image=agent-sandbox-ui:latest"; do
      attr="${img%%=*}"; name="${img#*=}"
      echo "==> $name"
      # The TAG must survive: skopeo rejects a bare name ("reference agent-host
      # has neither a tag nor a digest"), so do not strip ":latest" here.
      nix run ".#${attr}.copyTo" -- "docker-daemon:${name}"
    done
    k3d image import agent-host:latest agent-sandbox-os:latest \
      conversation-controller:latest conversation-router:latest agent-broker:latest \
      agent-webhooks:latest agent-db-migrator:latest agent-sandbox-ui:latest \
      byoc-controller:latest -c {{_K3D_CLUSTER}}
    # Secrets the manifests MOUNT but do not create: a deployment supplies them
    # out of band, so a fresh cluster cannot start without them. Idempotent.
    kubectl create ns agent-sandbox --dry-run=client -o yaml | kubectl apply -f -
    for s in agent-remote-join-secret agent-conv-token-secret; do
      kubectl -n agent-sandbox create secret generic "$s" \
        --from-literal=secret="local-k3d-$s" \
        --dry-run=client -o yaml | kubectl apply -f -
    done
    kubectl apply -f "$(nix build .#platform-manifests --no-link --print-out-paths)"
    # A PV left Released by an earlier namespace delete never rebinds; clear the
    # stale claimRef so the agent-host PVCs bind instead of hanging Pending.
    for pv in agent-host-assets agent-host-history; do
      [ "$(kubectl get pv "$pv" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Released" ] \
        && kubectl patch pv "$pv" -p '{"spec":{"claimRef":null}}' >/dev/null || true
    done
    # Match CI: podCap=1 + 3 replicas so conversations spread across pods and
    # per-pod-view bugs are visible.
    kubectl -n agent-sandbox set env deployment/conversation-controller CONVERSATION_POD_CAP=1
    kubectl -n agent-sandbox scale deployment/agent-host --replicas=3
    for d in conversation-controller agent-host conversation-router ui; do
      kubectl -n agent-sandbox rollout status "deployment/$d" --timeout=300s
    done
    kubectl -n agent-sandbox annotate deployment/ui "scooter.dev/fingerprint=$(just _fingerprint)" --overwrite >/dev/null
    echo "platform up — now run: just e2e-full"


# cluster-up.sh names the cluster too; keep the two in step or a local run targets
# a cluster that does not exist.
_K3D_CLUSTER := env_var_or_default("K3D_CLUSTER", "agent-sandbox")

# attr=image:deployment; the deployment is named explicitly because it cannot be
# derived from the image name (agent-sandbox-ui's deployment is "ui").
_PLATFORM_IMAGES := "agent-host-image=agent-host:agent-host conversation-controller-image=conversation-controller:conversation-controller conversation-router-image=conversation-router:conversation-router broker-image=agent-broker:agent-broker webhooks-image=agent-webhooks:agent-webhooks ui-image=agent-sandbox-ui:ui"

# Print the content fingerprint of every platform image: the nix derivation path is
# content-addressed and evaluates without building, is stored on the deployment as
# an annotation, and is compared on every run.
[private]
_fingerprint:
    #!/usr/bin/env bash
    set -euo pipefail
    for pair in {{_PLATFORM_IMAGES}}; do
      attr="${pair%%=*}"
      printf '%s=%s\n' "$attr" "$(nix eval --raw ".#${attr}.drvPath" 2>/dev/null | xargs basename)"
    done
    # The migrator, so a schema change reruns the migrate Job.
    printf 'db-migrator-image=%s\n' "$(nix eval --raw ".#db-migrator-image.drvPath" 2>/dev/null | xargs basename)"
    # The manifests too, since a CRD schema change is invisible to the image
    # fingerprints and the apiserver prunes fields the live CRD does not know.
    printf 'platform-manifests=%s\n' "$(nix eval --raw ".#platform-manifests.drvPath" 2>/dev/null | xargs basename)"

# Rebuild + reload only the platform images whose source changed, then restart them.
cluster-redeploy:
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh); a stale ~/.kube/config
    # would otherwise point at the wrong cluster.
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
    # Schema before services: rerun migrations on a new migrator.
    if printf '%s\n' "${changed[@]}" | grep -qx db-migrator-image; then
      echo "==> migrations changed — rerunning the migrate Job"
      nix run ".#db-migrator-image.copyTo" -- "docker-daemon:agent-db-migrator:latest"
      k3d image import agent-db-migrator:latest -c {{_K3D_CLUSTER}}
      kubectl -n agent-sandbox delete job -l app.kubernetes.io/name=agent-db-migrate --ignore-not-found >/dev/null
      kubectl apply -f "$(nix build .#platform-manifests --no-link --print-out-paths)" >/dev/null
      kubectl -n agent-sandbox wait --for=condition=complete job -l app.kubernetes.io/name=agent-db-migrate --timeout=300s
    fi
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
    # Stamp only after the rollouts succeed, or a redeploy that failed to restart
    # anything still reports "current".
    kubectl -n agent-sandbox annotate deployment/ui "scooter.dev/fingerprint=$want" --overwrite >/dev/null
    echo "redeployed"
# Run the cluster-project specs against the local platform (port-forwards the UI).
alias e2e-cluster := e2e-full

[positional-arguments]
e2e-full *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # k3d writes its kubeconfig here (see cluster-up.sh); a stale ~/.kube/config
    # would otherwise point at the wrong cluster.
    export KUBECONFIG="${KUBECONFIG_OVERRIDE:-${K3D_KUBECONFIG:-/tmp/scooter-k3d.kubeconfig}}"
    [ -s "$KUBECONFIG" ] || export KUBECONFIG="${HOME}/.kube/config"
    kubectl -n agent-sandbox get deployment/ui >/dev/null 2>&1 || {
      echo "no platform in the cluster — run: just cluster-platform" >&2; exit 1; }
    # A cluster running old images reports green while testing code you did not
    # write; the derivation path is content-addressed and evaluates in under a second.
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
    # Persist the run: everything lands in .e2e-cluster/ (the full log plus the pod
    # logs from the same window) so a failure can be investigated without
    # reproducing it.
    out=".e2e-cluster"
    # Wipe first, since pods change name on every redeploy and the artifacts must
    # describe this run only.
    rm -rf "$out"
    mkdir -p "$out"
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    set +e
    # Through e2e-full-run, so the --workers guard and the E2E_TARGET/E2E_CLUSTER_URL
    # contract live in one place.
    E2E_CLUSTER_URL=http://127.0.0.1:8899 \
      just e2e-full-run "$@" 2>&1 | tee "$out/run.log"
    rc=${PIPESTATUS[0]}
    set -e
    # Every pod in the namespace, whole log, all containers, plus the previous
    # container when one restarted; --since-time bounds time and the wipe above
    # bounds which pods.
    mkdir -p "$out/pods"
    for pod in $(kubectl -n agent-sandbox get pods -o name 2>/dev/null); do
      name="${pod#pod/}"
      # Since the run started, so stale failures from earlier runs do not read as
      # current.
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
    # The node's view: allocatable vs requested and taints/conditions, which is the
    # only place a sandbox Pending on Insufficient cpu shows.
    kubectl describe nodes >"$out/node.txt" 2>&1 || true
    kubectl get sandboxes.agents.x-k8s.io -n agent-sandbox -o yaml >"$out/sandboxes.yaml" 2>&1 || true
    echo ""
    echo "logs: $out/  (run.log, pods/*.log, state.txt, events.txt, conversations.yaml, describe-pods.txt, node.txt, sandboxes.yaml)"
    du -sh "$out" 2>/dev/null | awk '{print "      total: "$1}'
    exit "$rc"

# e2e full — a targeted subset against an already-served platform; shared with CI.
[positional-arguments]
e2e-full-run *ARGS:
    #!/usr/bin/env bash
    # The one guarded `--project=full` invocation, shared by `just e2e-full` (after
    # its port-forward) and CI's flake-focus-full (after e2e-full-serve.sh); it
    # starts no cluster and no port-forward of its own.
    #
    #   just e2e-full-run                                 # every full-allowlisted spec
    #   just e2e-full-run test/e2e/stop-run.spec.ts
    #   just e2e-full-run -g "queueing keeps thread"
    #   just e2e-full-run -g "..." --repeat-each=5 --trace on --reporter=list,json
    #
    # Never pass --workers, for the same reason as `just e2e` plus the shared
    # controller and the 4-vCPU node.
    set -euo pipefail
    if [[ " $* " == *" --workers"* ]]; then
      echo "error: --workers breaks this suite (shared agent-host state). See the comment in justfile." >&2
      exit 1
    fi
    # playwright.config.ts only defines the `full` project when E2E_TARGET=full.
    export E2E_TARGET=full
    # The full target's baseURL (playwright.config.ts `clusterUrl`); unset would
    # resolve every navigation against nothing.
    : "${E2E_CLUSTER_URL:?required — the served UI, e.g. http://127.0.0.1:8899 (just e2e-full forwards svc/ui there)}"
    # E2E_ROLLOUT_HOOK is optional: unset makes the rollout/move stories skip
    # (test/e2e/cluster-stories.spec.ts).
    npx playwright test --project=full "$@"

# --- Quality ---------------------------------------------------------------

typecheck:
    npm install
    # agent-host imports @scooter/claude-sdk-provider, @scooter/marimo-mcp and
    # @scooter/schema, so build them first for its NodeNext resolution.
    npm -w services/claude-sdk-provider run build
    npm -w services/marimo-mcp run build
    npm -w @scooter/schema run build
    npm -w services/agent-host run typecheck
    npm -w ui run typecheck
    npm -w contrib/code-server/ahp run typecheck
    # The generated Drizzle schema (catches broken/drifted generation at the type level).
    npm -w @scooter/schema run typecheck

lint: typecheck

# Guard against a stale stubs.lock: re-evaluate stubs.nix and fail if any recorded .drv
# differs. An in-repo stub (contrib/code-server/ahp) changes its .drv with every source edit, and a
# stale lock would silently ship the old build. Fix: nix run --inputs-from . nix-stubs#nix-stubs --
# gen --system x86_64-linux --system aarch64-linux --lock modules/sandbox-os/stubs.lock
check-stubs:
    nix run --inputs-from . nix-stubs#nix-stubs -- check --lock modules/sandbox-os/stubs.lock

# Guard against a stale package-lock.json: regenerate every lockfile
# (package-lock-only) with the flake's npm and fail if anything changes; the
# standalone ui/, services/agent-host/, byoc-controller and scooter-schema
# lockfiles are the ones buildNpmPackage uses.
check-lockfiles:
    npm install --package-lock-only --workspaces --include-workspace-root
    npm install --package-lock-only --prefix ui --workspaces=false
    npm install --package-lock-only --prefix services/agent-host --workspaces=false
    npm install --package-lock-only --prefix services/byoc-controller --workspaces=false
    npm install --package-lock-only --prefix lib/ts/scooter-schema --workspaces=false
    npm install --package-lock-only --prefix contrib/files/viewer-ui --workspaces=false
    npm install --package-lock-only --prefix contrib/code-server/ahp --workspaces=false
    @git diff --exit-code -- package-lock.json ui/package-lock.json services/agent-host/package-lock.json services/byoc-controller/package-lock.json lib/ts/scooter-schema/package-lock.json contrib/files/viewer-ui/package-lock.json contrib/code-server/ahp/package-lock.json \
      || (echo "❌ lockfile drift: a package.json changed without regenerating the lockfile. Run 'nix develop -c just check-lockfiles' and commit the result." && exit 1)
    @echo "✅ lockfiles are in sync with package.json"

# Guard against a stale npmDepsHash: recompute each buildNpmPackage hash from its
# lockfile (prefetch-npm-deps, no full build) and fail if the committed one differs.
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
    check contrib/files/viewer-ui/package-lock.json contrib/files/viewer-ui/default.nix
    check contrib/code-server/ahp/package-lock.json contrib/code-server/ahp/default.nix
    [ "$fail" -eq 0 ] && echo "✅ npmDepsHash values match their lockfiles"
    exit "$fail"

# Every image a module tells a deploy to pull must be published, and every
# published image must be size-benchmarked.
check-image-coverage:
    @scripts/check-image-coverage.sh

# `bash -n` the CI scripts, which shellcheck cannot parse inside their
# `bash -c '...'` blocks and which otherwise fail only minutes into a cluster job.
check-shell-syntax:
    @.github/scripts/check-shell-syntax.sh

# Every contrib directory must be imported by contrib/all-modules.nix, and its
# halves must use the filenames the evals look for.
check-contrib-coverage:
    @scripts/check-contrib-coverage.sh

# Pin contrib skill-directory sources in contrib/skills.lock (`--update` re-pins to HEAD).
lock-skills *args:
    @scripts/lock-skills.sh {{args}}

# Every declared skill-directory source is pinned, and nothing else is.
check-skill-lock:
    @scripts/lock-skills.sh --check

# The conversation-token test vector is committed once per service, and the copies
# must stay identical for the cross-language check to mean anything.
check-conv-token-vector:
    @scripts/check-conv-token-vector.sh

# --- Database schema (Atlas) ------------------------------------------------
# The shared Postgres schema is declared in lib/sql/<db>/schema.sql, with Atlas
# owning the migrations under lib/sql/<db>/migrations and each recipe spinning its
# own ephemeral Postgres as the dev database (scripts/atlas-dev.sh). The database
# list is read from the generated owners.toml at parse time, so it has to be a
# file read rather than `nix eval`.

db_envs := `sed -n 's/^\[\([a-z_][a-z_0-9]*\)\]$/\1/p' lib/sql/owners.toml | tr "\n" " "`

# Regenerate everything derived from the schema spec (owners.toml, atlas.hcl, and
# the @scooter/schema and scooter_schema bindings) and commit the result.
db-generate:
    scripts/db-generate.sh

# CI drift guard: regenerate and fail if the committed output of either source
# differs.
db-generate-check:
    scripts/db-generate.sh
    @git diff --exit-code -- lib/ts/scooter-schema/src lib/py/scooter-schema/src \
      lib/sql/owners.toml lib/sql/atlas.hcl \
      || (echo "❌ generated drift: the scooter.db spec or lib/sql changed without regenerating. Run 'nix develop -c just db-generate' and commit the result." && exit 1)
    @echo "✅ generated spec artifacts + ORM bindings are in sync"

# Author migrations from schema.sql for every database whose schema changed;
# usage: just db-migrate <name>.
db-migrate name:
    #!/usr/bin/env bash
    set -euo pipefail
    for env in {{db_envs}}; do
      echo "== $env =="
      scripts/atlas-dev.sh migrate diff {{name}} --env "$env"
    done

# CI drift guard: schema.sql must be fully expressed by its migrations (spins an
# ephemeral Postgres per env).
db-migrate-check:
    #!/usr/bin/env bash
    set -euo pipefail
    for env in {{db_envs}}; do
      out="$(scripts/atlas-dev.sh migrate diff ci_drift_probe --env "$env" 2>&1)"
      if ! printf '%s' "$out" | grep -q "no changes to be made"; then
        printf '%s\n' "$out"
        echo "❌ $env: schema.sql has changes with no migration. Run 'nix develop -c just db-migrate <name>' and commit the result."
        git checkout -- "lib/sql/$env/migrations" 2>/dev/null || true
        git clean -fq "lib/sql/$env/migrations" 2>/dev/null || true
        exit 1
      fi
    done
    echo "✅ every schema.sql is fully expressed by its migrations"

# Validate every database's migration directory (order, checksums, replayability).
db-validate:
    #!/usr/bin/env bash
    set -euo pipefail
    for env in {{db_envs}}; do
      echo "== $env =="
      scripts/atlas-dev.sh migrate validate --env "$env"
    done

# Everything CI runs.
ci: check-flake check-manifests check-stubs check-image-coverage check-contrib-coverage check-skill-lock check-conv-token-vector check-lockfiles check-npm-hashes check-shell-syntax lint db-generate-check db-migrate-check test-unit
    @echo "✅ ci (fast) passed — run 'just test' for cluster + e2e tiers"

# Build + serve the docs site locally (mkdocs + the generated kubenix option pages).
docs:
    nix build .#options-doc -o /tmp/scooter-options-doc
    SCOOTER_OPTIONS_JSON=/tmp/scooter-options-doc/share/doc/nixos/options.json \
      python3 docs/gen_options.py
    nix shell --impure --expr 'with import <nixpkgs> {}; python3.withPackages (p: [ p.mkdocs p.mkdocs-material p.mkdocs-awesome-pages-plugin ])' \
      --command mkdocs serve
