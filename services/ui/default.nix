{ lib, buildNpmPackage, nodejs, ... }:

# UI: assistant-ui frontend + the reusable AG-UI client library (services/ui/src/client.ts).
# Builds the static site (vite -> dist/) and installs it to $out, ready to be
# copied into an nginx image (services/ui/image.nix). The UI calls the agent-host via
# same-origin relative paths behind a reverse proxy, so VITE_AGENT_HOST_URL is left empty.

let
  fs = lib.fileset;
  # Contrib settings tabs (contrib/<name>/ui/*.tsx) compile into this bundle, so the
  # source is this directory plus every contrib's ui/ directory, laid out as in the repo. Only
  # those directories: editing a contrib's Python does not rebuild the UI.
  contribUi = lib.filter builtins.pathExists
    (map (n: ../../contrib + "/${n}/ui") (builtins.attrNames (builtins.readDir ../../contrib)));
in
buildNpmPackage {
  pname = "agent-sandbox-ui";
  version = "0.0.0";
  src = fs.toSource {
    root = ../..;
    fileset = fs.unions ([ (fs.fromSource (lib.cleanPackageSource ./.)) ] ++ contribUi);
  };
  sourceRoot = "source/services/ui";

  npmDepsHash = "sha256-Zg/llp0NIWOTMgeEx3AJBumUjqqeuA3akS2eqUS4NkI=";

  # Same-origin: relative /agui + /sessions (reverse-proxied to the agent-host).
  VITE_AGENT_HOST_URL = "";


  # A contrib tab lives outside this directory, so its bare imports (react, …) resolve by walking
  # up from contrib/<name>/ui and never meet its node_modules. In the repo the npm
  # workspace hoists node_modules to the root; mirror that here.
  # Only sourceRoot is writable after unpack; the link goes at the source root.
  postUnpack = ''
    chmod u+w "$sourceRoot/../.."
  '';
  postConfigure = ''
    ln -s "$PWD/node_modules" ../../node_modules
  '';

  # Static output from `npm run build`, no bin to wrap.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist/* $out/
    runHook postInstall
  '';

  meta.description = "agent-sandbox UI — assistant-ui + AG-UI runtime (static site)";
}
