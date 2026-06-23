{ lib, buildNpmPackage, nodejs, ... }:

# UI: assistant-ui frontend + the reusable AG-UI client library (ui/src/client.ts).
# Design stage: build stub.

buildNpmPackage {
  pname = "agent-sandbox-ui";
  version = "0.0.0";
  src = ./.;
  npmDepsHash = lib.fakeHash;
  dontNpmBuild = true; # placeholder until sources + lockfile exist
}
