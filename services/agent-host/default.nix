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

let
  # The installed app dir under $out/lib/node_modules is named by package.json "name"
  # (NOT pname). Read it deterministically at eval time so the provider symlinks target
  # the RIGHT node_modules (see the postInstall note on the old nondeterministic find).
  appName = (lib.importJSON ./package.json).name;
in
buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-dRjy/GQDIhEHVwsZJrd44As3CSXdBVdaFR3+USQJKq4=";

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
  '' + lib.optionalString (claudeSdkProvider != null || marimoMcp != null) ''
    # The runtime `import("@scooter/...")` must resolve from the installed app's OWN
    # package dir. buildNpmPackage installs it at $out/lib/node_modules/<name>, where
    # <name> is package.json "name" (NOT pname) — read it deterministically here.
    #
    # DO NOT `find ... -path '*/dist/index.js' | head -1`: that matches ANY dependency's
    # dist/index.js (e.g. pg-cloudflare) and find's order is filesystem-dependent, so on
    # some machines it resolved appdir to a NESTED dep and linked the providers into the
    # wrong node_modules — a nondeterministic build failure. The package name is exact;
    # read it from the SOURCE package.json at eval time (cwd-independent, deterministic).
    appdir="$out/lib/node_modules/${appName}"
    if [ ! -d "$appdir/dist" ]; then
      echo "postInstall: expected app at $appdir (with dist/), not found — did package.json 'name' change?" >&2
      exit 1
    fi
    mkdir -p "$appdir/node_modules/@scooter"
  '' + lib.optionalString (claudeSdkProvider != null) ''
    echo "linking claude-sdk-provider into $appdir/node_modules"
    ln -sf ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      "$appdir/node_modules/@scooter/claude-sdk-provider"
  '' + lib.optionalString (marimoMcp != null) ''
    echo "linking marimo-mcp into $appdir/node_modules"
    ln -sf ${marimoMcp}/lib/node_modules/@scooter/marimo-mcp \
      "$appdir/node_modules/@scooter/marimo-mcp"
  '';

  meta.description = "agent-host — runs goose ACP per conversation, ACP<->AG-UI";
}
