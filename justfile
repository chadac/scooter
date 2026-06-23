# kubenix-agent-sandbox task runner.
# `just` with no args lists recipes. See docs/TESTING.md for the test strategy.

# Cluster provider for Tier 2/3 (existing | k3s | kind | minikube | k3d)
cluster_provider := env_var_or_default("CLUSTER_PROVIDER", "k3s")

default:
    @just --list

# --- Build -----------------------------------------------------------------

# Evaluate the flake structure (fast; does not build derivations).
check-flake:
    nix flake show

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

# Tier 2 — cluster tests against a real Kubernetes (fake ACP agent).
test-cluster: cluster-up
    RUN_CLUSTER_TESTS=1 CLUSTER_PROVIDER={{cluster_provider}} npm run test:cluster

# Tier 3 — Playwright E2E through the UI (fake ACP agent).
test-e2e:
    npm run test:e2e

# Tier 3 — the single real-`goose acp` E2E (needs a model key).
test-e2e-real:
    RUN_REAL_GOOSE=1 npm run test:e2e -- real-goose

# Broker credential-flow cluster tests (post-PoC; needs broker deployed).
test-broker: cluster-up
    RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 CLUSTER_PROVIDER={{cluster_provider}} npm run test:cluster -- broker

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
    npm -w agent-host run typecheck
    npm -w ui run typecheck

lint: typecheck

# Everything CI runs.
ci: check-flake lint test-unit
    @echo "✅ ci (fast) passed — run `just test` for cluster + e2e tiers"
