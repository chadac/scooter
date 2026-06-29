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

# --- Quality ---------------------------------------------------------------

typecheck:
    npm install
    npm -w services/agent-host run typecheck
    npm -w ui run typecheck

lint: typecheck

# Everything CI runs.
ci: check-flake check-manifests lint test-unit
    @echo "✅ ci (fast) passed — run `just test` for cluster + e2e tiers"
