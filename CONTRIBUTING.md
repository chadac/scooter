# Contributing to Scooter

## Building & testing

[`just`](https://github.com/casey/just) is the task runner. **The tests are the
spec** — run them to confirm changes rather than assuming.

```bash
just test-quick     # Tier 1 contract tests — fast, no cluster. Run constantly.
just test           # FULL suite: Tier 1 + Tier 2 (cluster) + Tier 3 (E2E).
just ci             # What CI runs: flake check + typecheck + Tier 1.
```

Per tier:

```bash
just test-unit       # Tier 1  (no cluster, no network)
just test-cluster    # Tier 2  (real k8s; auto-starts a local k3s cluster)
just test-e2e        # Tier 3  (Playwright through the UI; fake ACP agent)
just test-e2e-real   # Tier 3  (one scenario with REAL goose; needs a model key)
```

Build:

```bash
just build           # agent-host + UI + sandbox image
just build-image     # just the sandbox-os image
just image-sizes     # measure shipped image sizes (JSON)
```

## Releasing

A release is a PR that bumps `VERSION` and adds a `## vX.Y.Z` section to the
top of `CHANGELOG.md`, summarising the changes merged since the last tag
(`git log vX.Y.Z..origin/main`). Bump the minor version for new features and
the patch version for fixes only; the major version moves only when a
maintainer says so. Merging the PR runs `.github/workflows/release.yml`, which
tags the merge commit, creates the GitHub Release from that section, tags each
image with the version and publishes the flake to FlakeHub. If a step fails,
re-run the workflow; it skips what already exists.
