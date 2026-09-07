# Deployment-INJECTED CLI tools: a stub on PATH that builds `path:<dir>#<attr>`
# from a flake directory MOUNTED INTO THE POD (a deployment's `.scooter/`
# ConfigMap) the first time it is called. See docs/SCOOTER_DIR_INJECTION.md.
#
# This is the one lazy-tool case nix-stubs cannot cover, and the reason this
# module still exists after the stub refactor. A nix-stubs shim carries the
# package's build RECIPE, which means the package has to be known when the image
# is built. An injected tool is the opposite: the flake shows up at RUNTIME, in a
# ConfigMap the image has never seen, so resolution has to happen at runtime too.
#
# Everything else the old programs.lazyTools did — resolving `<pin>#uv` at runtime
# against a mounted pin, memoizing out-paths, the pin/byte-identity contract with
# the re-converge — is gone: those tools are nix-stubs shims now
# (modules/sandbox-os/stubs.nix), and a shim needs no pin, no runtime eval, and no
# cache file.

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
