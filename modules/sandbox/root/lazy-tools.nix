# Lazy tool stubs — a tool materializes (builds from Nix) on first use, so the
# base image ships none of their closures. The core is `config.lib.mkLazyTool`, a
# BUILDER any NixOS module can call to declare its own lazy tool inline (no
# central registry, no image rebuild) — including a deployment's own
# `.scooter/module.nix`. `programs.lazyTools.tools` is just a convenience registry
# re-expressed on top of mkLazyTool.
#
# mkLazyTool resolution sources (a stub picks one based on its inputs):
#   - package = "uv"        (attr STRING)  -> nix build <pin>#uv at runtime (LIGHT)
#   - flake = "<dir>"; package = "x"       -> nix build path:<dir>#x  (deployment-injected)
#   - package = pkgs.uv     (a DERIVATION) -> exec ${pkgs.uv}/bin/<bin> (in-closure)
# plus commands = [ "uv" "uvx" ] to expose multiple bins from one package.
#
# The pin (pinFile / defaultNixpkgs) flows from this module's config, so callers
# don't repeat it. See docs/DEV_ENVIRONMENT_DESIGN.md + docs/SCOOTER_DIR_INJECTION.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.lazyTools;

  # The builder. Returns a derivation with one stub per command.
  #   mkLazyTool { package; flake ? null; commands ? null; bin ? null; name ? ... }
  # `package` is either an attr-name STRING (resolved from the pin or `flake`) or a
  # Nix DERIVATION (execed directly — already in the closure).
  mkLazyTool =
    { package
    , flake ? null            # resolve from this local flake DIR instead of the pin
    , commands ? null         # bins to expose; default [ <name> ]
    , bin ? null              # the binary under /bin to exec; default <name>
    , name ? (if lib.isString package then package else (package.pname or package.name))
    }:
    let
      isDrv = !(lib.isString package);
      theBin = if bin != null then bin else name;
      cmds = if commands != null then commands else [ name ];
      cacheDir = cfg.cacheDir;

      stubText = cmd: ''
        # --- lazy tool stub: ${cmd} (${name}) ---
        set -euo pipefail
        cache_dir=${lib.escapeShellArg cacheDir}
        bin=${lib.escapeShellArg theBin}
        ${if isDrv then ''
        # EVAL-TIME package: it's already realised in the store — just exec it.
        target=${lib.escapeShellArg "${package}/bin/${theBin}"}
        exec "$target" "$@"
        '' else ''
        pkg=${lib.escapeShellArg package}
        # Cache by the TOOL (name+package), not the command, so aliases share one
        # resolve (e.g. uv + uvx, or hello + hi -> one nix build).
        cache_file="$cache_dir/${name}"
        ${lib.optionalString (flake != null) "local_flake=${lib.escapeShellArg flake}"}

        ${if flake != null then ''
        # Resolve from a mounted local flake dir (a deployment's .scooter ConfigMap).
        if [ ! -e "$local_flake/flake.nix" ]; then
          echo "lazy-tools: ${cmd}: flake not mounted at $local_flake" >&2
          exit 127
        fi
        ref="path:$local_flake"
        # The mounted dir is read-only + may have a path: input -> --impure.
        extra_args="--impure"
        '' else ''
        # Resolve from the pinned nixpkgs: the mounted pin ConfigMap wins, else
        # the built-in default. Re-pinning is a ConfigMap edit, no rebuild.
        pin_file=${lib.escapeShellArg cfg.pinFile}
        ref=${lib.escapeShellArg cfg.defaultNixpkgs}
        extra_args=""
        if [ -r "$pin_file" ]; then
          if v=$(${pkgs.jq}/bin/jq -er '.nixpkgs' "$pin_file" 2>/dev/null); then ref="$v"; fi
        fi
        ''}

        # Fast path: cached {ref, out} for THIS tool whose store path still exists.
        # We cache the PACKAGE out-path (shared across the tool's commands), then
        # each command picks its own bin from it.
        out=""
        if [ -r "$cache_file" ]; then
          cached_ref=$(sed -n 1p "$cache_file"); cached_out=$(sed -n 2p "$cache_file")
          if [ "$cached_ref" = "$ref" ] && [ -e "$cached_out" ]; then out="$cached_out"; fi
        fi

        # Resolve (slow once) if not cached.
        if [ -z "$out" ]; then
          # shellcheck disable=SC2086
          out=$(nix build --no-link --print-out-paths --no-write-lock-file $extra_args "$ref#$pkg")
          if mkdir -p "$cache_dir" 2>/dev/null; then
            printf '%s\n%s\n' "$ref" "$out" > "$cache_file" 2>/dev/null || true
          fi
        fi

        if [ -x "$out/bin/$bin" ]; then exec "$out/bin/$bin" "$@"
        elif [ -x "$out" ]; then exec "$out" "$@"
        else echo "lazy-tools: ${cmd}: no executable at $out/bin/$bin or $out" >&2; exit 127; fi
        ''}
      '';
    in
    pkgs.runCommand "lazy-tool-${name}"
      { nativeBuildInputs = [ pkgs.makeWrapper ]; }
      (lib.concatMapStringsSep "\n"
        (cmd: ''
          mkdir -p $out/bin
          cat > $out/bin/${cmd} <<'STUB_EOF'
          #!${pkgs.runtimeShell}
          ${stubText cmd}
          STUB_EOF
          chmod +x $out/bin/${cmd}
        '')
        cmds);

  toolModule = lib.types.submodule ({ name, ... }: {
    options = {
      package = lib.mkOption {
        type = lib.types.str;
        description = "Attribute in the pinned nixpkgs (or in `localFlake`) to build, e.g. \"uv\".";
      };
      bin = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Binary under the package's /bin to exec. Defaults to the command name.";
      };
      commands = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = "Commands (bins) to expose on PATH. Defaults to [ <attr name> ].";
      };
      localFlake = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Resolve from a LOCAL flake DIRECTORY mounted into the sandbox (e.g. a
          deployment's `.scooter/` ConfigMap) instead of the pinned nixpkgs. The
          stub builds `path:<localFlake>#<package>`. See docs/SCOOTER_DIR_INJECTION.md.
        '';
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
        { "nixpkgs": "github:NixOS/nixpkgs/<rev>" }. Read at resolve time.
      '';
    };

    defaultNixpkgs = lib.mkOption {
      type = lib.types.str;
      description = "Fallback pinned nixpkgs flake ref when pinFile is absent (tests/local).";
    };

    cacheDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/cache/lazy-tools";
      description = "Where resolved /nix/store paths are memoized (one file per command).";
    };

    tools = lib.mkOption {
      type = lib.types.attrsOf toolModule;
      default = { };
      example = lib.literalExpression ''
        { uv.package = "uv"; python = { package = "python3"; bin = "python3"; }; }
      '';
      description = ''
        Convenience registry of lazy tools (re-expressed via config.lib.mkLazyTool).
        Any module can instead call `config.lib.mkLazyTool {...}` directly.
      '';
    };
  };

  config = {
    # Expose the builder as a MODULE ARGUMENT so ANY module (incl. a deployment's
    # .scooter/module.nix) can `{ mkLazyTool, ... }:` and declare its own lazy tool
    # inline, with the pin flowing from this config automatically.
    _module.args.mkLazyTool = mkLazyTool;

    # The convenience registry: each tools.<name> -> a mkLazyTool derivation.
    environment.systemPackages = lib.mkIf cfg.enable (
      lib.mapAttrsToList
        (name: tool: mkLazyTool {
          inherit name;
          package = tool.package;
          bin = tool.bin;
          commands = if tool.commands != null then tool.commands else [ name ];
          flake = tool.localFlake;
        })
        cfg.tools
    );

    # The memoize cache dir exists at boot so the first stub call doesn't race.
    systemd.tmpfiles.rules = lib.mkIf cfg.enable [ "d ${cfg.cacheDir} 0755 root root -" ];
  };
}
