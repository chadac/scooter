# The developer shell — everything needed to build, test (Tier 1-3), and drive a
# local cluster. Factored out of flake.nix so the shell definition lives in one
# place and `.envrc` (`use flake`) / `nix develop` share it.
#
# Deliberately a plain `mkShell` (not devenv.sh): this repo pins a SINGLE nixpkgs
# (see flake.nix) that the sandbox image, its lazy-tool stubs, and the runtime
# re-converge all resolve against. A separate devenv input would add its own
# nixpkgs surface; keeping the shell on the flake's pkgs avoids that drift.
{ pkgs }:

pkgs.mkShell {
  packages = with pkgs; [
    # JS toolchain (agent-host + ui + tests)
    nodejs_22
    # cluster tooling — local k8s + control
    kubectl
    kind
    k3d
    kubernetes-helm
    # image plumbing
    skopeo
    # the ACP agent the agent-host spawns
    goose-cli
    # e2e: Nix-wrapped Playwright browsers (the downloaded ones fail
    # on NixOS — missing libglib etc.)
    playwright-driver.browsers
    # misc used by scripts/tests
    jq
    yq-go
    just
  ];
  shellHook = ''
    echo "kubenix-agent-manager dev shell"
    echo "  just            — task runner (test-quick, test, test-cluster, ...)"
    echo "  goose: $(command -v goose >/dev/null && goose --version 2>/dev/null | head -1 || echo absent)"
    export GOOSE_BIN="$(command -v goose || true)"
    # Point Playwright at the Nix browsers + skip its host-req validation. The
    # pinned nixpkgs `playwright-driver` version matches `@playwright/test` in
    # package.json (both 1.60.0), so these browsers are the right revision — the
    # downloaded ones fail on NixOS (missing libglib etc.).
    export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
    # playwright.config.ts reads PW_CHROME to set launchOptions.executablePath —
    # without it Playwright ignores PLAYWRIGHT_BROWSERS_PATH's chrome and tries its
    # own (unusable-on-NixOS) download. Resolve the chromium binary out of the Nix
    # browsers bundle by glob so it survives a driver-revision bump (chromium-<rev>).
    export PW_CHROME="$(echo "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux64/chrome | head -n1)"
    if [ ! -x "$PW_CHROME" ]; then
      # Older layouts used chrome-linux/chrome — fall back before giving up.
      export PW_CHROME="$(echo "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux/chrome | head -n1)"
    fi
    echo "  chrome (e2e): ''${PW_CHROME:-not found}"
  '';
}
