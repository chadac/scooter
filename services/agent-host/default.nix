{ lib, buildNpmPackage, nodejs, makeWrapper, goose-cli, agent ? goose-cli, claudeSdkProvider ? null, scooterSchemaJs ? null, ... }:

# Builds the agent-host TypeScript app (tsc -> dist/) into a node application with
# the ACP agent wrapped onto PATH. `agent` must be the same goose derivation the
# image's gooseLayer bakes, or the closure ships goose twice. `claudeSdkProvider`
# and `scooterSchemaJs` are isolated @scooter/* packages linked into
# node_modules so their imports resolve at tsc time and at runtime; each is optional.

let
  # The installed app dir under $out/lib/node_modules is named by package.json "name", not pname.
  appName = (lib.importJSON ./package.json).name;
in
buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-yH3J82SWehFbJLmbDYtFBAnDrjK+3q5govyYUIn3h9g=";

  nativeBuildInputs = [ makeWrapper ];

  # Link the isolated packages into node_modules after npm ci and before `tsc` runs.
  postConfigure = lib.optionalString (claudeSdkProvider != null) ''
    mkdir -p node_modules/@scooter
    ln -s ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      node_modules/@scooter/claude-sdk-provider
  '' + lib.optionalString (scooterSchemaJs != null) ''
    # @scooter/schema is copied as a real dir, so its drizzle-orm type imports resolve to agent-host's own drizzle-orm and share one type identity.
    mkdir -p node_modules/@scooter/schema
    cp -rL ${scooterSchemaJs}/lib/node_modules/@scooter/schema/dist node_modules/@scooter/schema/dist
    cp -L ${scooterSchemaJs}/lib/node_modules/@scooter/schema/package.json node_modules/@scooter/schema/package.json
    chmod -R u+w node_modules/@scooter/schema
  '';

  postInstall = ''
    wrapProgram $out/bin/agent-host \
      --prefix PATH : ${lib.makeBinPath [ agent nodejs ]}
  '' + lib.optionalString (claudeSdkProvider != null || scooterSchemaJs != null) ''
    # The runtime `import("@scooter/...")` must resolve from the installed app's own package dir.
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
  '' + lib.optionalString (scooterSchemaJs != null) ''
    echo "copying scooter-schema into $appdir/node_modules (real dir; drizzle-orm resolves from agent-host)"
    mkdir -p "$appdir/node_modules/@scooter/schema"
    cp -rL ${scooterSchemaJs}/lib/node_modules/@scooter/schema/dist "$appdir/node_modules/@scooter/schema/dist"
    cp -L ${scooterSchemaJs}/lib/node_modules/@scooter/schema/package.json "$appdir/node_modules/@scooter/schema/package.json"
    chmod -R u+w "$appdir/node_modules/@scooter/schema"
  '';

  meta.description = "agent-host — runs goose ACP per conversation, ACP<->AG-UI";
}
