{ lib, buildNpmPackage, nodejs, ... }:

# The generated Drizzle schema package (@scooter/schema): the shared table definitions
# + ownership guard, compiled from lib/sql/*/schema.sql by `just db-generate`. Built as
# its OWN npm package so a service can consume the tables without pulling the whole
# workspace; the agent-host image symlinks it into node_modules/@scooter/schema so
# agent-host resolves the import at `tsc` time AND at runtime. Same isolation pattern as
# services/claude-sdk-provider and services/marimo-mcp — see services/agent-host/default.nix.
#
# The src/<db>.ts modules are GENERATED (do not hand-edit); CI fails on drift
# (just db-generate-check). This derivation only compiles them + ships the runtime dep.

buildNpmPackage {
  pname = "scooter-schema-js";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-BA9sMAPR9jwYzdQ4vheK7a7ovwRTWmFNF2/C7+XnJOA=";

  # A custom installPhase bypasses buildNpmPackage's own dev-prune hook, so prune
  # explicitly: the ONLY runtime dependency is drizzle-orm — drizzle-kit, vitest and the
  # vite/esbuild tree are all build-time. Without this the image ships 100MB+ of build
  # tooling (and an unpatchable static esbuild binary). --offline so prune uses the
  # build's npm cache, not the registry.
  #
  # Then drop @electric-sql/pglite explicitly: drizzle-orm lists it as an OPTIONAL peer
  # so `npm prune` keeps it, but it is a 26MB wasm test-postgres never imported by the
  # node-postgres runtime path (resourceMapping.ts). Finally sweep the empty scope dirs
  # prune leaves behind, so the shipped tree is just drizzle-orm + its real deps.
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --offline
    rm -rf node_modules/@electric-sql
    find node_modules -type d -empty -delete
    mkdir -p $out/lib/node_modules/@scooter/schema
    cp -r dist package.json node_modules $out/lib/node_modules/@scooter/schema/
    runHook postInstall
  '';

  meta.description = "@scooter/schema — generated Drizzle schema (isolated)";
}
