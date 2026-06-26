# programs.lazyTools — extensible "lazy Nix-built tool stubs on PATH".
#
# Each declared tool becomes a light PATH stub that, on first call, resolves the
# real package from a pinned nixpkgs (via `nix build`), memoizes the resolved
# /nix/store path (tagged with the pin rev), and execs it. Subsequent calls hit
# the cache and exec directly. Keeps the base image small: common tools aren't
# baked in, they materialize on first use.
#
# The pin comes from a mounted ConfigMap (pinFile) so it can change without an
# image rebuild; defaultNixpkgs is the fallback when the ConfigMap isn't mounted
# (tests / local). See docs/DEV_ENVIRONMENT_DESIGN.md.
#
# STAGE 3 (red-first): the OPTION SCHEMA is real and evaluable; the stub
# GENERATION in config is intentionally NOT implemented yet, so the nixosTests
# that exercise a stub fail until Stage 5 fills it in.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.lazyTools;

  toolModule = lib.types.submodule ({ name, ... }: {
    options = {
      package = lib.mkOption {
        type = lib.types.str;
        description = "Attribute in the pinned nixpkgs to build (e.g. \"uv\", \"python3\").";
      };
      bin = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Binary under the package's /bin to exec. Defaults to the tool's attr name.";
      };
    };
  });
in
{
  options.programs.lazyTools = {
    enable = lib.mkEnableOption "lazy Nix-built tool stubs on PATH";

    pinFile = lib.mkOption {
      type = lib.types.str;
      default = "/etc/agent-sandbox/nix/pin.json";
      description = ''
        Path to a JSON file (a mounted ConfigMap) pinning nixpkgs:
        { "nixpkgs": "github:NixOS/nixpkgs/<rev>" }. Read at resolve time, so
        re-pinning is a ConfigMap edit — no image rebuild.
      '';
    };

    defaultNixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        Fallback pinned nixpkgs flake ref used when pinFile is absent (tests,
        local). e.g. "github:NixOS/nixpkgs/<rev>".
      '';
    };

    cacheDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/cache/lazy-tools";
      description = "Where resolved /nix/store paths are memoized (one file per tool, tagged with the pin rev).";
    };

    tools = lib.mkOption {
      type = lib.types.attrsOf toolModule;
      default = { };
      example = lib.literalExpression ''
        { uv.package = "uv"; python = { package = "python3"; bin = "python3"; }; }
      '';
      description = ''
        Tools to expose as lazy stubs. The attr name is the command on PATH.
        EXTENSIBLE: other agent configs add entries here, no code change.
      '';
    };
  };

  # STAGE 5 will implement: generate one stub script per tool and add them to the
  # system PATH (environment.systemPackages). Until then config is a no-op so the
  # module evaluates but the stubs don't exist — the lazy-stub nixosTest is RED.
  config = lib.mkIf cfg.enable {
    # TODO(stage5): environment.systemPackages = [ (mkStubs cfg) ];
  };
}
