{ lib, buildNpmPackage, nodejs, makeWrapper, goose-cli, agent ? goose-cli, claudeSdkProvider ? null, marimoMcp ? null, ... }:

# Builds the agent-host TypeScript app (tsc -> dist/) into a node application,
# with `goose` (the ACP agent) wrapped onto PATH.
#
# `agent` is the goose package to put on PATH — defaults to nixpkgs' goose-cli, but
# the flake passes the PATCHED goose (bedrock tool-name sanitize). It MUST be the same
# derivation the image's gooseLayer bakes, else the closure ships goose TWICE (~455MB
# duplicate) AND the wrapper's PATH could run the unpatched goose. Keep them one.
#
# `claudeSdkProvider` is the isolated Claude Agent SDK provider derivation (zod v4,
# kept out of THIS package's zod-v3 tree). We symlink its built package into
# node_modules/@scooter/claude-sdk-provider so agent-host resolves the import both at
# `tsc` time and at runtime. Optional (null) so a bare callPackage still works.

buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-QDM8l5hmIb7XBxo27y4sbpnNcGu8Vk56M3kAoGGTkEM=";

  nativeBuildInputs = [ makeWrapper ];

  # Link the isolated provider into node_modules BEFORE `tsc` runs, so the import
  # `@scooter/claude-sdk-provider` resolves (its .d.ts + dist). buildNpmPackage runs
  # npm ci in the configure phase; do this in postConfigure (after node_modules exists).
  postConfigure = lib.optionalString (claudeSdkProvider != null) ''
    mkdir -p node_modules/@scooter
    ln -s ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      node_modules/@scooter/claude-sdk-provider
  '' + lib.optionalString (marimoMcp != null) ''
    mkdir -p node_modules/@scooter
    ln -s ${marimoMcp}/lib/node_modules/@scooter/marimo-mcp \
      node_modules/@scooter/marimo-mcp
  '';

  # `npm run build` (tsc) emits dist/; bin agent-host -> dist/index.js.
  postInstall = ''
    wrapProgram $out/bin/agent-host \
      --prefix PATH : ${lib.makeBinPath [ agent nodejs ]}
  '' + lib.optionalString (claudeSdkProvider != null) ''
    # The runtime `import("@scooter/claude-sdk-provider")` must resolve from the
    # installed app's OWN package dir (named by package.json "name", NOT pname). Find
    # the dir that holds dist/index.js and link the provider into ITS node_modules.
    appdir="$(dirname "$(dirname "$(find $out/lib/node_modules -name index.js -path '*/dist/index.js' | head -1)")")"
    echo "linking claude-sdk-provider into $appdir/node_modules"
    mkdir -p "$appdir/node_modules/@scooter"
    ln -sf ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      "$appdir/node_modules/@scooter/claude-sdk-provider"
  '' + lib.optionalString (marimoMcp != null) ''
    appdir="$(dirname "$(dirname "$(find $out/lib/node_modules -name index.js -path '*/dist/index.js' | head -1)")")"
    echo "linking marimo-mcp into $appdir/node_modules"
    mkdir -p "$appdir/node_modules/@scooter"
    ln -sf ${marimoMcp}/lib/node_modules/@scooter/marimo-mcp \
      "$appdir/node_modules/@scooter/marimo-mcp"
  '';

  meta.description = "agent-host — runs goose ACP per conversation, ACP<->AG-UI";
}
