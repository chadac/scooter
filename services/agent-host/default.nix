{ lib, buildNpmPackage, nodejs, makeWrapper, goose-cli, ... }:

# Builds the agent-host TypeScript app (tsc -> dist/) into a node application,
# with `goose` (the ACP agent) wrapped onto PATH.

buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-loYcDSdYCyFRIXcJoQ7/Ute6U3SrQ8cSPHexSIx1jMs=";

  nativeBuildInputs = [ makeWrapper ];

  # `npm run build` (tsc) emits dist/; bin agent-host -> dist/index.js.
  postInstall = ''
    wrapProgram $out/bin/agent-host \
      --prefix PATH : ${lib.makeBinPath [ goose-cli nodejs ]}
  '';

  meta.description = "agent-host — runs goose ACP per conversation, ACP<->AG-UI";
}
