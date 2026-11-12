# Scooter on this machine, declared: `nix run . -- up` (docs: "Local deployments").
{
  inputs = {
    scooter.url = "github:chadac-me/scooter";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, scooter, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, ... }:
        let
          # scooter-local built for ./scooter.nix: `up` applies that configuration.
          local = scooter.lib.mkLocal { inherit system; module = ./scooter.nix; };
        in
        {
          packages.default = local;
          # The same render as YAML, for `kubectl apply -f` on a cluster of your own.
          packages.manifests = local.manifests.${local.provider};
        };

      # On NixOS instead: import this and set services.scooter-local (see the docs).
      flake.nixosModules.default = { imports = [ scooter.nixosModules.local ]; services.scooter-local = { enable = true; settings = import ./scooter.nix; }; };
    };
}
