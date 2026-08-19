{ lib, buildNpmPackage, nodejs, makeWrapper, claudeSdkProvider ? null, claude-code ? null, ... }:

# The bring-your-own-Claude container app: drives the user's LOCAL Claude (via the isolated
# @scooter/claude-sdk-provider — the same SDK driver the agent-host uses) and tunnels tool-exec back
# to the cloud sandbox over a WS. Symlinks the built claudeSdkProvider into node_modules (like
# agent-host), and wraps the bin so a glibc `claude` CLI is on PATH (the SDK bundles a musl one).

buildNpmPackage {
  pname = "scooter-remote-agent";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-1IBHrmPuDFmMxBSRkFKl+1Paq0r52Br5Kg+8yTObph4=";
  # The Claude Agent SDK's transitive/peer deps aren't fully captured by the v1 fetcher (ENOTCACHED
  # on install); the v2 fetcher resolves them from the lockfile. (Same SDK the provider bundles.)
  npmDepsFetcherVersion = 2;

  nativeBuildInputs = [ makeWrapper ];

  # The Claude Agent SDK peer-depends on zod ^4 etc.; skip peer resolution (ENOTCACHED offline).
  npmFlags = [ "--legacy-peer-deps" ];
  dontNpmPrune = true;

  # Symlink the separately-built provider so `@scooter/claude-sdk-provider` resolves at build +
  # runtime (same technique as services/agent-host/default.nix).
  postConfigure = lib.optionalString (claudeSdkProvider != null) ''
    mkdir -p node_modules/@scooter
    ln -s ${claudeSdkProvider}/lib/node_modules/@scooter/claude-sdk-provider \
      node_modules/@scooter/claude-sdk-provider
  '';

  # `npm run build` (tsc) emits dist/. Install the whole tree + a wrapped bin. Put a glibc `claude`
  # on PATH (CLAUDE_CODE_COMMAND) so the SDK spawns it instead of its bundled musl binary.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/scooter-remote-agent
    cp -r dist package.json node_modules $out/lib/scooter-remote-agent/
    makeWrapper ${nodejs}/bin/node $out/bin/scooter-remote-agent \
      --add-flags $out/lib/scooter-remote-agent/dist/main.js \
      ${lib.optionalString (claude-code != null) "--set CLAUDE_CODE_COMMAND ${claude-code}/bin/claude --prefix PATH : ${claude-code}/bin"}
    runHook postInstall
  '';

  meta = {
    description = "Bring-your-own-Claude remote agent (drives local Claude, tunnels tools to the cloud sandbox)";
    mainProgram = "scooter-remote-agent";
  };
}
