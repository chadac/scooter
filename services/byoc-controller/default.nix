{ lib, buildNpmPackage, nodejs, ... }:

# The BYOC controller — holds the bring-your-own-Claude container sockets so ANY agent-host
# replica can drive ANY container (todo/done/BYO_CLAUDE_REMOTE_AGENT.md §L).
buildNpmPackage {
  pname = "byoc-controller";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-/wBP3fp2kAnCDsn2FOoWcYpJLBTkQxi1MHWlJo/W0lA=";

  dontNpmBuild = false;
  npmBuildScript = "build";

  meta = {
    description = "BYOC controller: owns the user's Claude container socket; agent-hosts drive it over HTTP/SSE";
    mainProgram = "byoc-controller";
  };
}
