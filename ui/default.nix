{ lib, buildNpmPackage, nodejs, contribManifest ? null, ... }:

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

  npmDepsHash = "sha256-1cOej29YtcUgfUbhVrDy+IiZ8tq5hcFiCLMIMKXc6+U=";

  # A contrib's UI half is compiled INTO the bundle (the icons and panels are
  # React; there is no runtime module loader), so the DEPLOYMENT's contrib set
  # has to be substituted before vite runs. The committed overlay is the in-repo
  # set, which is what makes `npm run dev`/vitest work; a deployment overrides it
  # here. Replaced wholesale rather than merged, so a contrib the deployment
  # dropped cannot leave its panel source behind. See contrib/ui-manifest.nix.
  postPatch = lib.optionalString (contribManifest != null) ''
    rm -rf src/contrib
    cp -rT ${contribManifest} src/
  '';

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
