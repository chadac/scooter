{ lib, buildNpmPackage, nodejs, ... }:

# Design stage: build stub. Implementation builds the TypeScript agent-host
# into a node app and wraps it with `goose` on PATH (the ACP agent it spawns).
#
# buildNpmPackage {
#   pname = "agent-host";
#   version = "0.0.0";
#   src = ./.;
#   npmDepsHash = lib.fakeHash;   # pin at implementation
#   nativeBuildInputs = [ nodejs ];
#   # goose is provided at runtime via the deployment, not bundled here.
# }

buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;
  npmDepsHash = lib.fakeHash;
  dontNpmBuild = true; # placeholder until sources + lockfile exist
}
