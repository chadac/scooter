# Deployment-INJECTED CLI tools: a stub that builds `path:<dir>#<attr>` from a
# flake directory MOUNTED INTO THE POD (a deployment's `.scooter/` ConfigMap) on
# first call. See docs/SCOOTER_DIR_INJECTION.md.
#
# Separate from modules/sandbox-os/stubs.nix because a nix-stubs shim needs the
# package at IMAGE BUILD time to bake its recipe, and an injected flake only
# exists at runtime. Resolution therefore has to be deferred. See PR #502.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.injectedTools;

  mkStub = name: tool:
    let
      cmds = if tool.commands != null then tool.commands else [ name ];
      theBin = if tool.bin != null then tool.bin else name;
    in
    pkgs.runCommand "injected-tool-${name}" { } (lib.concatMapStringsSep "\n"
      (cmd: ''
        mkdir -p $out/bin
        cat > $out/bin/${cmd} <<'STUB_EOF'
        #!${pkgs.runtimeShell}
        set -euo pipefail
        flake_dir=${lib.escapeShellArg tool.flake}
        if [ ! -e "$flake_dir/flake.nix" ]; then
          echo "injected-tools: ${cmd}: no flake mounted at $flake_dir" >&2
          exit 127
        fi
        # The mounted dir is read-only and may carry a `path:` input, so --impure.
        out=$(nix build --no-link --print-out-paths --no-write-lock-file --impure \
                "path:$flake_dir#${tool.package}")
        exec "$out/bin/${theBin}" "$@"
        STUB_EOF
        chmod +x $out/bin/${cmd}
      '')
      cmds);

  toolType = lib.types.submodule {
    options = {
      package = lib.mkOption {
        type = lib.types.str;
        description = "Attribute to build from the mounted flake, e.g. \"example-review\".";
      };
      flake = lib.mkOption {
        type = lib.types.str;
        default = "/etc/agent-sandbox/scooter";
        description = "Directory the deployment's flake is mounted at.";
      };
      bin = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Binary under the package's /bin. Defaults to the tool name.";
      };
      commands = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = "Commands to expose on PATH. Defaults to [ <name> ].";
      };
    };
  };
in
{
  options.programs.injectedTools = {
    enable = lib.mkEnableOption "deployment-injected CLI tools built from a mounted flake";

    tools = lib.mkOption {
      type = lib.types.attrsOf toolType;
      default = { };
      example = lib.literalExpression ''
        { example-review = { package = "example-review"; }; }
      '';
      description = "Tools resolved from a flake directory mounted into the pod.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = lib.mapAttrsToList mkStub cfg.tools;
  };
}
