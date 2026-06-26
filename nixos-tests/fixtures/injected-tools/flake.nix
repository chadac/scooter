# Fixture .scooter/ flake — stands in for a deployment's injected tools dir
# (e.g. a deployment's, defining example-review). Exposes one trivial package built
# with nixpkgs (writeShellScriptBin), the realistic shape for a real tool.
#
# nixpkgs is a flake input; the test pins it to its own nixpkgs source (a `path:`
# override) and pre-seeds the closure, so the in-VM `nix build path:<dir>#tool`
# is offline. A real deployment pins nixpkgs the same way.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs";
  outputs = { self, nixpkgs }: {
    packages = builtins.listToAttrs (map
      (system: {
        name = system;
        value.injected-tool =
          nixpkgs.legacyPackages.${system}.writeShellScriptBin "injected-tool"
            "echo injected-tool-from-mounted-dir-ok";
      })
      [ "x86_64-linux" "aarch64-linux" ]);
  };
}
