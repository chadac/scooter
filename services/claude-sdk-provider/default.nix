{ lib, buildNpmPackage, nodejs, ... }:

# The isolated Claude Agent SDK provider. Built as its OWN npm package so the
# SDK's zod v4 stays out of the agent-host tree (which is on zod v3). Emits dist/
# + its bundled node_modules; the agent-host image symlinks this into
# node_modules/@scooter/claude-sdk-provider so agent-host resolves it at build +
# runtime. See services/agent-host/default.nix.

buildNpmPackage {
  pname = "claude-sdk-provider";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-7WJdCLigV9ioEeMnMgbwJzr+uGxYQP3VARbI68RxXp8=";

  # The Claude Agent SDK peer-depends on zod ^4 / @anthropic-ai/sdk / mcp-sdk; those
  # are already in our deps, but npm's peer resolution otherwise tries to reach the
  # registry (ENOTCACHED in the sandbox). --legacy-peer-deps skips that resolution.
  npmFlags = [ "--legacy-peer-deps" ];

  # `npm run build` (tsc) emits dist/. The package has no bin — it's a library the
  # agent-host imports. Keep node_modules (the SDK + zod v4) in the output so the
  # runtime `import("@anthropic-ai/claude-agent-sdk")` resolves.
  dontNpmPrune = true;

  # buildNpmPackage's default install runs `npm pack`/copies dist; we want the
  # whole package tree (dist + node_modules) available for the symlink. Install to
  # $out/lib/node_modules/@scooter/claude-sdk-provider.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/@scooter/claude-sdk-provider
    cp -r dist package.json node_modules $out/lib/node_modules/@scooter/claude-sdk-provider/
    runHook postInstall
  '';

  meta.description = "Claude Agent SDK-backed AcpClient (isolated; zod v4)";
}
