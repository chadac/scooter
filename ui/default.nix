{ lib, buildNpmPackage, nodejs, ... }:

# UI: assistant-ui frontend + the reusable AG-UI client library (ui/src/client.ts).
# Builds the static site (vite -> dist/) and installs it to $out, ready to be
# copied into an nginx image (pkgs/ui-image).
#
# The UI calls the agent-host via same-origin relative paths (/agui, /sessions),
# so it's served behind a reverse proxy that forwards those to the agent-host.
# VITE_AGENT_HOST_URL is left empty => same-origin.

buildNpmPackage {
  pname = "agent-sandbox-ui";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-1zo+0WdtEavVXI6VYIdzNj6j99UqnGd0gXftxutv2KI=";

  # Same-origin: relative /agui + /sessions (reverse-proxied to the agent-host).
  VITE_AGENT_HOST_URL = "";

  # `npm run build` -> dist/. Static output, no bin to wrap.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';

  meta.description = "agent-sandbox UI — assistant-ui + AG-UI runtime (static site)";
}
