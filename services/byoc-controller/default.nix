{ lib, buildNpmPackage, nodejs, scooterSchemaJs ? null, ... }:

# The BYOC controller — holds the bring-your-own-Claude container sockets so ANY agent-host
# replica can drive ANY container (todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §L).
#
# `scooterSchemaJs` is the generated @scooter/schema package (Drizzle tables). sessionStore.ts
# imports its byoc.remote_agents table. We COPY its dist (not symlink) into node_modules/@scooter/
# schema so its drizzle-orm/pg-core imports resolve to THIS package's own drizzle-orm via walk-up —
# a single drizzle type identity, else the schema's PgColumn types mismatch db.select() (tsc
# TS2322). Same rationale as services/agent-host/default.nix. Optional (null) so a bare callPackage
# still works.
let
  appName = (lib.importJSON ./package.json).name;
in
buildNpmPackage {
  pname = "byoc-controller";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-GKXAfTgZu7zqI8pOBIX1osgZyaePqPx8i4NyYAhvxHs=";

  dontNpmBuild = false;
  npmBuildScript = "build";

  # Copy @scooter/schema's dist as a REAL dir BEFORE tsc, so its type imports resolve to this
  # package's drizzle-orm (see the header note). npm ci ran in configurePhase, so drizzle-orm is
  # already in node_modules here.
  postConfigure = lib.optionalString (scooterSchemaJs != null) ''
    mkdir -p node_modules/@scooter/schema
    cp -rL ${scooterSchemaJs}/lib/node_modules/@scooter/schema/dist node_modules/@scooter/schema/dist
    cp -L ${scooterSchemaJs}/lib/node_modules/@scooter/schema/package.json node_modules/@scooter/schema/package.json
    chmod -R u+w node_modules/@scooter/schema
  '';

  # The runtime import("@scooter/schema") must resolve from the installed app's OWN package dir
  # ($out/lib/node_modules/<name>, where <name> is package.json "name"). Copy dist there too, so
  # its drizzle-orm/pg-core resolves the installed app's drizzle-orm.
  postInstall = lib.optionalString (scooterSchemaJs != null) ''
    appdir="$out/lib/node_modules/${appName}"
    if [ ! -d "$appdir/dist" ]; then
      echo "postInstall: expected app at $appdir (with dist/), not found — did package.json 'name' change?" >&2
      exit 1
    fi
    mkdir -p "$appdir/node_modules/@scooter/schema"
    cp -rL ${scooterSchemaJs}/lib/node_modules/@scooter/schema/dist "$appdir/node_modules/@scooter/schema/dist"
    cp -L ${scooterSchemaJs}/lib/node_modules/@scooter/schema/package.json "$appdir/node_modules/@scooter/schema/package.json"
    chmod -R u+w "$appdir/node_modules/@scooter/schema"
  '';

  meta = {
    description = "BYOC controller: owns the user's Claude container socket; agent-hosts drive it over HTTP/SSE";
    mainProgram = "byoc-controller";
  };
}
