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
      localFlake = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Resolve this tool from a LOCAL flake DIRECTORY (a path MOUNTED into the
          sandbox, e.g. a deployment's `.scooter/` ConfigMap) instead of the
          pinned nixpkgs. The stub builds `path:<localFlake>#<package>`. This is
          how a DEPLOYMENT injects its own CLI tool (scooter-review, …) into the
          generic sandbox at runtime — no flake ref, no image rebuild, instant
          (it's just a package, not a system rebuild). See docs/HYPERNIX_INJECTION.md.
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

  config = lib.mkIf cfg.enable {
    # One PATH stub per declared tool. On first call the stub resolves the real
    # package from the pinned nixpkgs (`nix build`), memoizes the resolved /bin
    # path to cacheDir (tagged with the pin rev), and execs it. Later calls hit
    # the cache and exec directly — so a tool is only slow the very first time,
    # and the base image ships none of these tools' closures.
    environment.systemPackages =
      lib.mapAttrsToList
        (name: tool:
          let
            bin = if tool.bin != null then tool.bin else name;
          in
          pkgs.writeShellApplication {
            name = name;
            # The stub needs nix (to resolve) + jq (to read the pin file) + the
            # coreutils it uses. nix comes from the system; we only declare jq.
            runtimeInputs = [ pkgs.jq pkgs.coreutils ];
            # Don't let shellcheck rewrite the careful quoting / exec.
            checkPhase = "";
            text = ''
              # --- lazy tool stub: ${name} -> ${tool.package} (${bin}) ---
              set -euo pipefail

              pin_file=${lib.escapeShellArg cfg.pinFile}
              default_ref=${lib.escapeShellArg cfg.defaultNixpkgs}
              cache_dir=${lib.escapeShellArg cfg.cacheDir}
              pkg=${lib.escapeShellArg tool.package}
              bin=${lib.escapeShellArg bin}
              cache_file="$cache_dir/${name}"
              ${lib.optionalString (tool.localFlake != null)
                "local_flake=${lib.escapeShellArg tool.localFlake}"}

              ${if tool.localFlake != null then ''
              # DEPLOYMENT-INJECTED tool: resolve from a local flake dir (a mounted
              # .scooter ConfigMap), not the pinned nixpkgs. No flake ref needed.
              if [ ! -e "$local_flake/flake.nix" ]; then
                echo "lazy-tools: ${name}: flake not mounted at $local_flake" >&2
                echo "  (the deployment must mount its .scooter ConfigMap there)" >&2
                exit 127
              fi
              ref="path:$local_flake"
              # The mounted flake dir is read-only and may have a path: nixpkgs
              # input (not a content-locked one) — --impure lets it resolve
              # without a strict lock. Trusted: it's the deployment's own dir.
              extra_args="--impure"
              '' else ''
              # The pinned nixpkgs ref: the mounted ConfigMap (pinFile) wins; else
              # the built-in default. Re-pinning is a ConfigMap edit, no rebuild.
              ref="$default_ref"
              extra_args=""
              if [ -r "$pin_file" ]; then
                if v=$(jq -er '.nixpkgs' "$pin_file" 2>/dev/null); then
                  ref="$v"
                fi
              fi
              ''}

              # Fast path: a cache entry for THIS ref whose path still exists.
              if [ -r "$cache_file" ]; then
                cached_ref=$(sed -n 1p "$cache_file")
                cached_path=$(sed -n 2p "$cache_file")
                if [ "$cached_ref" = "$ref" ] && [ -x "$cached_path" ]; then
                  exec "$cached_path" "$@"
                fi
              fi

              # Resolve: realise the package and find its binary. Slow once.
              # --no-write-lock-file: a mounted .scooter flake dir is READ-ONLY,
              # so nix mustn't try to write a flake.lock into it.
              # shellcheck disable=SC2086
              out=$(nix build --no-link --print-out-paths --no-write-lock-file $extra_args "$ref#$pkg")
              # Prefer $out/bin/<bin> (the usual layout); fall back to $out itself
              # being the executable (a bare-script derivation / meta.mainProgram).
              if [ -x "$out/bin/$bin" ]; then
                target="$out/bin/$bin"
              elif [ -x "$out" ]; then
                target="$out"
              else
                echo "lazy-tools: ${name}: no executable at $out/bin/$bin or $out" >&2
                exit 127
              fi

              # Memoize {ref, path} so later calls skip the resolve. Best-effort:
              # if the cache dir isn't writable we still run, just not cached.
              if mkdir -p "$cache_dir" 2>/dev/null; then
                printf '%s\n%s\n' "$ref" "$target" > "$cache_file" 2>/dev/null || true
              fi

              exec "$target" "$@"
            '';
          })
        cfg.tools;

    # The memoize cache lives on tmpfs-or-disk; ensure the dir exists at boot so
    # the first stub call doesn't race to create it.
    systemd.tmpfiles.rules = [ "d ${cfg.cacheDir} 0755 root root -" ];
  };
}
