{ lib, buildNpmPackage, nodejs, makeWrapper, ... }:

# The in-sandbox Agent Host Protocol server code-server bridges to (see src/main.ts). Shipped
# as a nix-stubs shim (../stubs.nix), so it costs nothing until VS Code starts.
buildNpmPackage {
  pname = "scooter-vscode-ahp";
  version = "0.0.0";
  src = ./.;

  npmDepsHash = "sha256-J5sY97SY1dcGlowabHC7Fjd0VbD5O83puOGBfGlmY5Q=";

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/scooter-vscode-ahp
    cp -r dist package.json node_modules $out/lib/scooter-vscode-ahp/
    makeWrapper ${nodejs}/bin/node $out/bin/scooter-vscode-ahp \
      --add-flags $out/lib/scooter-vscode-ahp/dist/main.js
    runHook postInstall
  '';

  meta = {
    description = "Agent Host Protocol server exposing the sandbox's Scooter conversation to VS Code";
    mainProgram = "scooter-vscode-ahp";
  };
}
