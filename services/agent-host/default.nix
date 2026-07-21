{ lib, buildNpmPackage, nodejs, makeWrapper, goose-cli, agent ? goose-cli, ... }:

# Builds the agent-host TypeScript app (tsc -> dist/) into a node application,
# with `goose` (the ACP agent) wrapped onto PATH.
#
# `agent` is the goose package to put on PATH — defaults to nixpkgs' goose-cli, but
# the flake passes the PATCHED goose (bedrock tool-name sanitize). It MUST be the same
# derivation the image's gooseLayer bakes, else the closure ships goose TWICE (~455MB
# duplicate) AND the wrapper's PATH could run the unpatched goose. Keep them one.

buildNpmPackage {
  pname = "agent-host";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-TM8kMTnbt4yV+fFORXC69vVF31JWPzv6+SCQMmUJkOA=";

  nativeBuildInputs = [ makeWrapper ];

  # `npm run build` (tsc) emits dist/; bin agent-host -> dist/index.js.
  postInstall = ''
    wrapProgram $out/bin/agent-host \
      --prefix PATH : ${lib.makeBinPath [ agent nodejs ]}
  '';

  meta.description = "agent-host — runs goose ACP per conversation, ACP<->AG-UI";
}
