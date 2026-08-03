{ lib, buildNpmPackage, nodejs, ... }:

# The isolated marimo MCP server (marimo protocol client + notebook tools). Built as
# its OWN npm package; the agent-host image symlinks it into
# node_modules/@scooter/marimo-mcp so agent-host resolves it at build + runtime.
# See services/agent-host/default.nix (same pattern as claude-sdk-provider).

buildNpmPackage {
  pname = "marimo-mcp";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-HKok4tz2OSuxl70Lmd5+RiiCLXN9QzE1pqekw9MZXjk=";

  npmFlags = [ "--legacy-peer-deps" ];

  # Keep node_modules (mcp-sdk + zod v3) so the runtime import resolves.
  dontNpmPrune = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/@scooter/marimo-mcp
    cp -r dist package.json node_modules $out/lib/node_modules/@scooter/marimo-mcp/
    runHook postInstall
  '';

  meta.description = "marimo MCP server — notebook tools (isolated)";
}
