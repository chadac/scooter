# programs.scooterModule — apply a deployment's `.scooter/module.nix` (a NixOS
# module) into the running sandbox AT RUNTIME via switch-to-configuration. No
# image rebuild, no flake ref: the module is MOUNTED (e.g. a ConfigMap) and the
# pod rebuilds its own toplevel (base config + the mounted module) and switches.
#
# This unifies the dev-env work: full NixOS-module power (packages, systemd
# services, config) delivered at runtime, the way the switch-specialisation spike
# proved (PID 1 survives, ~seconds, only the changed-unit diff restarts).
#
# Ships into the image:
#   - the base-config builder expression (runtime-converge/base-config.nix);
#   - the pinned nixpkgs + the modules/sandbox-os source, as store paths, so the
#     in-pod build needs no network/ref;
#   - `scooter-apply-module`: build <base + mounted module> -> switch.
#
# See docs/HYPERNIX_INJECTION.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterModule;

  # agent-broker (the authenticated broker curl wrapper) — used by scooter-rebuild's
  # registry subcommands (module add/detach + publish) to talk to the broker's module
  # registry with the pod's SA token. Same package that carry-over.nix puts on PATH.
  brokerTools = pkgs.callPackage ../../../pkgs/broker-tools { };

  # The base-config entrypoint + vendored modules tree the in-pod build feeds to it.
  # Factored into a shared helper so the nixosTest pre-builds the re-converged
  # toplevel from the IDENTICAL derivations (else: cache miss -> offline from-source
  # build that hangs in the VM). See runtime-converge/reconverge-inputs.nix.
  inherit (import ./runtime-converge/reconverge-inputs.nix { inherit pkgs lib; })
    baseConfig modulesTree modulesSrc;

  # The modules-source path the in-pod build feeds to base-config, AND the tree baked
  # into system.extraDependencies. At IMAGE build (cfg.modulesTree = null) both come from
  # the derived `modulesTree`/`modulesSrc`. At RE-CONVERGE, base-config sets cfg.modulesTree
  # to the ALREADY-BAKED tree store path (from its own modulesPath), so we reference THAT
  # everywhere instead of re-deriving: a self-modify re-eval of reconverge-inputs.nix (its
  # `lib.cleanSource ../.` now runs against the baked store subtree, not the repo) produces
  # a DIFFERENT sandbox-os-src hash that was never built → "path '…-sandbox-os-src' is not
  # valid". Both the `nix build` modulesPath arg AND extraDependencies must use the baked
  # tree, or the re-converged scooter-apply-module bakes the bad path into its own script.
  effTree = if cfg.modulesTree != null then builtins.storePath cfg.modulesTree else modulesTree;
  effModulesSrc = if cfg.modulesTree != null then "${builtins.storePath cfg.modulesTree}/modules/sandbox/root" else modulesSrc;

  # The canonical system profile — registering each switch here gives us the
  # numbered-generation ladder NixOS uses for rollback. The symlinks
  # (system, system-N-link) are plain files on the writable rootfs, NOT in the
  # (possibly overlay) Nix store, so they're writable even with a read-only lower.
  systemProfile = "/nix/var/nix/profiles/system";

  # Where scooter-apply-module writes its status/error/log — read by
  # scooter-env-status (the agent's poll) + the agent-host completion watcher. On
  # /run (tmpfs): a fresh boot starts with no stale status, and it's writable.
  statusDir = "/run/scooter/env-switch";

  # The real config's switch = the SHARED scooter-rebuild engine (status/log protocol,
  # --detach re-exec, generation register, switch-in-scope, health-gate → rollback) with a
  # REAL-CONFIG buildCommand: the base-config `nix build --expr` + the --module resolution / CM
  # fallback / no-op guards. So there is ONE switch implementation across the bootstrap + the
  # real config; only the BUILD strategy differs (the flag). See pkgs/sandbox-shared/scooter-rebuild.
  # (`applyModule` keeps its name here for the callers below; the BINARY is now `scooter-rebuild`.)
  applyModule = pkgs.callPackage ../../../pkgs/sandbox-shared/scooter-rebuild {
    # A DISTINCT name from the scooter-rebuild CLI dispatcher below (which wraps this engine) —
    # the dispatcher execs it by store path, so `scooter-rebuild switch` doesn't recurse.
    name = "scooter-rebuild-switch";
    inherit systemProfile statusDir;
    # The real config's build: resolve --module (forwarded as "$@") + the deployment-CM
    # fallback, skip a genuine no-op, else build base-config with the extra module spliced in.
    buildCommand = ''
      # An EXTRA module to splice into the re-converge (forwarded via "$@" from the engine).
      # None → build the BASE config alone (it imports local-modules /etc/scooter/modules +
      # broker/registry modules), so a plain `scooter-rebuild switch` picks up authored modules.
      module=""
      cm_module=${lib.escapeShellArg cfg.dir}/module.nix
      while [ $# -gt 0 ]; do
        case "$1" in
          --module) module="$2"; shift 2 ;;
          *) echo "scooter-rebuild: unknown build arg: $1" >&2; exit 2 ;;
        esac
      done
      # No explicit --module: fall back to the deployment CM module IF it has content.
      if [ -z "$module" ] && [ -s "$cm_module" ] && [ -n "$(tr -d '[:space:]' < "$cm_module" 2>/dev/null)" ]; then
        module="$cm_module"
      fi

      # An EXPLICIT --module that's missing/empty/whitespace → drop it, re-converge base only (a
      # 0-byte file isn't a valid Nix module; the per-conversation CM is seeded 0-byte).
      if [ -n "$module" ] && { [ ! -e "$module" ] || [ ! -s "$module" ] || [ -z "$(tr -d '[:space:]' < "$module")" ]; }; then
        echo "scooter-rebuild: extra module $module is missing/empty — re-converging base only" >&2
        module=""
      fi

      # Genuine no-op: no extra module AND nothing for the base to pick up (no local *.nix, no
      # attached registry modules). Building base-only would rebuild for nothing — and a sandbox
      # with a placeholder nixpkgs (tests / not-yet-provisioned) can't build. Exit idle, no build.
      if [ -z "$module" ]; then
        local_mods=""
        [ -d /etc/scooter/modules ] && local_mods=$(find -L /etc/scooter/modules -maxdepth 1 -name '*.nix' -type f 2>/dev/null | head -1)
        reg_mods=""
        [ -s /etc/scooter/registry-modules.json ] && reg_mods=$(tr -d '[]" \n\t' < /etc/scooter/registry-modules.json 2>/dev/null)
        if [ -z "$local_mods" ] && [ -z "$reg_mods" ]; then
          echo "scooter-rebuild: no module and nothing to converge — nothing to apply" >&2
          write_status idle
          trap - EXIT
          exit 0
        fi
      fi

      if [ -n "$module" ]; then
        echo "scooter-rebuild: building toplevel (base + $module)..."
        module_expr="$module"
      else
        echo "scooter-rebuild: building toplevel (base config + local/registry modules)..."
        module_expr=""
      fi
      # Build base-config (+ the optional extra module). --impure to read the module path + the
      # local-modules dir; nixpkgs + modules source are fixed store paths baked in.
      toplevel=$(nix build --no-link --print-out-paths --impure --expr "
        (import ${baseConfig} {
          nixpkgs = ${cfg.nixpkgs};
          modulesPath = ${effModulesSrc};
          extraModules = [
            ${lib.concatStringsSep "\n            " cfg.extraReconvergeModules}
            $module_expr
          ];
        }).toplevel
      ")
    '';
  };

  # scooter-env-status — the agent's window into the (async) env switch — is the SHARED
  # derivation (pkgs/sandbox-shared/scooter-env-status), same statusDir contract as the engine.
  envStatus = pkgs.callPackage ../../../pkgs/sandbox-shared/scooter-env-status { inherit statusDir; };

  # scooter-rebuild — THE agent's environment entrypoint (nixos-rebuild-like). Owns
  # /etc/scooter (HARDCODED — no configurability). A thin dispatcher over the existing
  # switch machinery (scooter-apply-module / scooter-env-status) + local module editing
  # under /etc/scooter/modules (the symlinked, PVC-backed, agent-writable dir that
  # local-modules.nix composes) + the SHARED registry (attach/detach/publish via the
  # broker, which registry-modules.nix fetches into the same switch).
  #
  #   scooter-rebuild switch [--detach]     build + switch to the current config
  #   scooter-rebuild status [--log]        show the (async) switch status
  #   scooter-rebuild module list           list your authored modules
  #   scooter-rebuild module new <name>     create modules/<name>.nix from a template
  #   scooter-rebuild module edit <name>    $EDITOR modules/<name>.nix (create if absent)
  #   scooter-rebuild module show <name>    print modules/<name>.nix
  #   scooter-rebuild module rm <name>      delete modules/<name>.nix
  #   scooter-rebuild module search [q]     search the broker registry catalog
  #   scooter-rebuild module add <ref>      attach a registry module (name or id) + switch
  #   scooter-rebuild module detach <ref>   detach an attached registry module + switch
  #   scooter-rebuild module attached       list attached registry modules
  #   scooter-rebuild publish <name> [..]   publish local modules/<name>.nix to the registry
  scooterRebuild = pkgs.writeShellApplication {
    name = "scooter-rebuild";
    runtimeInputs = [ applyModule envStatus pkgs.coreutils brokerTools.agent-broker pkgs.jq ];
    text = ''
      set -euo pipefail

      # HARDCODED — scooter-rebuild owns /etc/scooter. modules/ is the agent-editable
      # dir (symlink -> workspace PVC) that local-modules.nix imports. The registry-ids
      # file is the attach-list registry-modules.nix fetches from the broker.
      MODULES_DIR=/etc/scooter/modules
      REGISTRY_IDS_FILE=/etc/scooter/registry-modules.json

      usage() {
        cat >&2 <<'EOF'
      scooter-rebuild — build + switch your sandbox environment.

        scooter-rebuild switch [--detach]   apply the current config (build + switch)
        scooter-rebuild status [--log]      show the switch status (+ log on failure)

      Local modules (yours, authored under /etc/scooter/modules/*.nix):
        scooter-rebuild module list                 list your local modules
        scooter-rebuild module new  <name>          create modules/<name>.nix (template)
        scooter-rebuild module edit <name>          edit modules/<name>.nix ($EDITOR)
        scooter-rebuild module show <name>          print modules/<name>.nix
        scooter-rebuild module rm   <name>          delete modules/<name>.nix

      Shared registry (attach modules others published, publish your own):
        scooter-rebuild module search [query]       search the registry catalog
        scooter-rebuild module add    <name-or-id>  attach a registry module (+ switch)
        scooter-rebuild module detach <name-or-id>  detach an attached registry module
        scooter-rebuild module attached             list your attached registry modules
        scooter-rebuild publish <name> [--public] [--description D]
                                                    publish local modules/<name>.nix to the registry

      Your modules live in /etc/scooter/modules/*.nix (durable on the workspace PVC).
      Edit them, then `scooter-rebuild switch`. A bad module fails the build (no switch).
      EOF
      }

      # Reject a name that isn't a plain module basename (no path traversal / slashes).
      module_path() {
        local name="$1"
        case "$name" in
          ""|*/*|.|..) echo "scooter-rebuild: invalid module name '$name'" >&2; exit 2 ;;
        esac
        printf '%s/%s.nix' "$MODULES_DIR" "$name"
      }

      cmd="''${1:-}"; shift || true
      case "$cmd" in
        switch)
          # Pass through --detach; scooter-apply-module with NO --module composes the
          # base config (which imports local + deployment/broker modules) -> the switch.
          exec ${applyModule}/bin/scooter-rebuild-switch switch "$@"
          ;;
        status)
          exec scooter-env-status "$@"
          ;;
        module)
          sub="''${1:-}"; shift || true
          case "$sub" in
            list|ls)
              mkdir -p "$MODULES_DIR"
              # -L: MODULES_DIR is a symlink (-> the workspace PVC dir); find won't
              # descend a symlinked start point without it.
              found=$(find -L "$MODULES_DIR" -maxdepth 1 -name '*.nix' -printf '%f\n' 2>/dev/null | sed 's/\.nix$//' | sort || true)
              if [ -z "$found" ]; then echo "no modules yet — create one with: scooter-rebuild module new <name>"; else echo "$found"; fi
              ;;
            new)
              name="''${1:-}"; path=$(module_path "$name")
              mkdir -p "$MODULES_DIR"
              if [ -e "$path" ]; then echo "scooter-rebuild: $name already exists (edit it: scooter-rebuild module edit $name)" >&2; exit 1; fi
              cat > "$path" <<'TEMPLATE'
      # A sandbox environment module. This is a NixOS module — declare packages,
      # services, env, etc. Run `scooter-rebuild switch` to apply.
      { pkgs, lib, ... }:
      {
        # environment.systemPackages = [ pkgs.jq ];
      }
      TEMPLATE
              echo "created $path — edit it, then: scooter-rebuild switch"
              ;;
            edit)
              name="''${1:-}"; path=$(module_path "$name")
              mkdir -p "$MODULES_DIR"
              [ -e "$path" ] || scooter-rebuild module new "$name" >/dev/null
              exec "''${EDITOR:-vi}" "$path"
              ;;
            show|cat)
              name="''${1:-}"; path=$(module_path "$name")
              [ -e "$path" ] || { echo "scooter-rebuild: no module '$name'" >&2; exit 1; }
              cat "$path"
              ;;
            rm|delete)
              name="''${1:-}"; path=$(module_path "$name")
              [ -e "$path" ] || { echo "scooter-rebuild: no module '$name'" >&2; exit 1; }
              rm -f "$path"
              echo "removed $name — run: scooter-rebuild switch"
              ;;
            search|find)
              # Query the broker catalog (own private + all public). No query -> all.
              q="''${1:-}"
              agent-broker "modules?q=$q" | jq -r '
                (.modules // []) as $m
                | if ($m | length) == 0 then "no modules found"
                  else ($m[] | "\(.name)  (#\(.id), \(.visibility))\(if (.description // "") != "" then "  — \(.description)" else "" end)")
                  end'
              ;;
            add|attach)
              # Attach a registry module by name OR numeric id. Resolve via the broker
              # so we store the CANONICAL name (the download endpoint tars under <name>/,
              # so registry-modules.json must hold names, not ids), and to fail fast on a
              # missing/invisible module before recording it.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module add: <name-or-id> required" >&2; exit 2; }
              name=$(agent-broker "modules/$ref" | jq -er '.name') \
                || { echo "scooter-rebuild: registry module '$ref' not found (or not visible to you)" >&2; exit 1; }
              [ -f "$REGISTRY_IDS_FILE" ] || echo '[]' > "$REGISTRY_IDS_FILE"
              # Idempotent add: no-op if already attached; keep the list unique + sorted.
              if jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null; then
                echo "$name is already attached"
              else
                tmp=$(mktemp)
                jq --arg n "$name" '. + [$n] | unique' "$REGISTRY_IDS_FILE" > "$tmp" && mv "$tmp" "$REGISTRY_IDS_FILE"
                echo "attached $name — applying..."
                exec ${applyModule}/bin/scooter-rebuild-switch switch "''${@:2}"
              fi
              ;;
            detach)
              # Remove an attached registry module. Accepts the stored name; also tries
              # resolving an id -> name so `detach <id>` works symmetrically with `add`.
              ref="''${1:-}"
              [ -n "$ref" ] || { echo "scooter-rebuild module detach: <name-or-id> required" >&2; exit 2; }
              [ -f "$REGISTRY_IDS_FILE" ] || { echo "no attached registry modules"; exit 0; }
              name="$ref"
              if ! jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null 2>&1; then
                # Not a stored name — maybe an id; ask the broker for the canonical name.
                name=$(agent-broker "modules/$ref" 2>/dev/null | jq -er '.name' 2>/dev/null || echo "$ref")
              fi
              if jq -e --arg n "$name" 'index($n)' "$REGISTRY_IDS_FILE" >/dev/null; then
                tmp=$(mktemp)
                jq --arg n "$name" 'map(select(. != $n))' "$REGISTRY_IDS_FILE" > "$tmp" && mv "$tmp" "$REGISTRY_IDS_FILE"
                echo "detached $name — applying..."
                exec ${applyModule}/bin/scooter-rebuild-switch switch "''${@:2}"
              else
                echo "$ref is not attached"
              fi
              ;;
            attached)
              if [ -f "$REGISTRY_IDS_FILE" ] && [ "$(jq 'length' "$REGISTRY_IDS_FILE")" -gt 0 ]; then
                jq -r '.[]' "$REGISTRY_IDS_FILE"
              else
                echo "no registry modules attached — attach one with: scooter-rebuild module add <name-or-id>"
              fi
              ;;
            ""|-h|--help) usage; exit 2 ;;
            *) echo "scooter-rebuild module: unknown subcommand '$sub'" >&2; usage; exit 2 ;;
          esac
          ;;
        publish)
          # Publish a LOCAL module (/etc/scooter/modules/<name>.nix) to the broker
          # registry. name = the local module name = the globally-unique registry name
          # (first publisher owns it; re-publishing your own bumps the version). Files
          # are sent as { "module.nix": <contents> } — the registry requires module.nix.
          name="''${1:-}"; shift || true
          [ -n "$name" ] || { echo "scooter-rebuild publish: <name> required" >&2; exit 2; }
          path=$(module_path "$name")
          [ -e "$path" ] || { echo "scooter-rebuild: no local module '$name' to publish (see: scooter-rebuild module list)" >&2; exit 1; }
          visibility=private; description=""
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --public)      visibility=public; shift ;;
              --private)     visibility=private; shift ;;
              --description)  description="''${2:-}"; shift 2 ;;
              *) echo "scooter-rebuild publish: unknown arg '$1'" >&2; exit 2 ;;
            esac
          done
          body=$(jq -n --arg n "$name" --arg v "$visibility" --arg d "$description" \
                    --rawfile c "$path" \
                    '{name:$n, visibility:$v, files:{"module.nix":$c}} + (if $d == "" then {} else {description:$d} end)')
          resp=$(agent-broker modules -X POST -H "Content-Type: application/json" -d "$body") \
            || { echo "scooter-rebuild: publish failed" >&2; exit 1; }
          # A non-2xx comes back as a JSON {detail:...} without an id — surface it.
          if id=$(printf '%s' "$resp" | jq -er '.id' 2>/dev/null); then
            ver=$(printf '%s' "$resp" | jq -r '.version')
            echo "published $name (#$id, $visibility, v$ver) — others attach it with: scooter-rebuild module add $name"
          else
            echo "scooter-rebuild: publish rejected: $(printf '%s' "$resp" | jq -r '.detail // .' 2>/dev/null || printf '%s' "$resp")" >&2
            exit 1
          fi
          ;;
        ""|-h|--help) usage; exit 2 ;;
        *) echo "scooter-rebuild: unknown command '$cmd'" >&2; usage; exit 2 ;;
      esac
    '';
  };
in
{
  options.programs.scooterModule = {
    enable = lib.mkEnableOption "runtime application of a mounted .scooter/module.nix via switch-to-configuration";

    dir = lib.mkOption {
      type = lib.types.str;
      default = "/etc/agent-sandbox/scooter";
      description = "Mount path of the deployment's .scooter dir (contains module.nix).";
    };

    nixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        Store path to the pinned nixpkgs the in-pod toplevel build uses (same rev
        the image was built from). Injected by the image builder so the build is
        deterministic + offline.
      '';
    };

    applyOnBoot = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run scooter-apply-module once at boot if a module is mounted.";
    };

    extraReconvergeModules = lib.mkOption {
      # A list of Nix expression STRINGS (module paths or inline modules) that the
      # re-converge ALWAYS layers on top of the base config — so the rebuilt
      # toplevel reflects the CURRENTLY-RUNNING system, not just the bare base.
      # This is how a runtime-applied switch preserves what's already active
      # instead of dropping units the base config doesn't declare (e.g. the
      # nixosTest framework's backdoor.service — without this the switch stops the
      # test's control channel and the test hangs). The image sets none; a test or
      # a deployment that injects extra node-level config threads it here.
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/nix/store/…-keep-backdoor.nix" ];
      description = "Extra module exprs always layered into the runtime re-converge (keeps currently-running config).";
    };

    modulesTree = lib.mkOption {
      # The vendored sandbox-os source tree (system.extraDependencies) that MUST be in
      # the pod's offline store for the in-pod re-converge build. Null (image default) =
      # use the derived `modulesTree` from reconverge-inputs.nix, which the image builder
      # bakes. base-config.nix (the re-converge) sets this to the ALREADY-BAKED tree store
      # path (derived from modulesPath) so the re-converged toplevel references the valid,
      # present path instead of re-deriving a fresh sandbox-os-src that isn't in the store
      # ("path '…-sandbox-os-src' is not valid"). Only relevant when enable = true.
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Store path of the baked sandbox-os source tree; null = re-derive it (image build).";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ applyModule envStatus scooterRebuild ];

    # CRITICAL: the in-pod `nix build` imports the modules tree (shipped here) and
    # the nixpkgs source. cfg.nixpkgs is a bare string (no Nix context), so it is
    # NOT pulled into the image closure by itself — the IMAGE BUILDER must add the
    # nixpkgs source to system.extraDependencies (where it still has context).
    # Without both, the in-pod build fails with "path does not exist".
    #
    # At IMAGE build (cfg.modulesTree = null): use the derived `modulesTree` and bake it.
    # At RE-CONVERGE (base-config sets cfg.modulesTree = the baked store path): reference
    # THAT already-valid path — the re-derived one hashes differently (its `lib.cleanSource
    # ../.` evaluates against the baked store subtree, not the repo, so a self-modify eval
    # produces a NEW sandbox-os-src that was never built → "path '…-sandbox-os-src' is not
    # valid"). Using the baked path keeps the re-converged toplevel offline-buildable.
    system.extraDependencies = [ effTree ];

    # Apply the mounted module at boot (best-effort; a missing module is a no-op).
    # The agent-host can also exec scooter-apply-module on spawn/claim.
    systemd.services.scooter-apply-module = lib.mkIf cfg.applyOnBoot {
      description = "Apply the mounted .scooter/module.nix via switch-to-configuration (async)";
      wantedBy = [ "multi-user.target" ];
      after = [ "nix-daemon.socket" ];
      # NON-BLOCKING: --detach forks the build+switch into the background and the
      # ExecStart returns IMMEDIATELY, so this unit does NOT gate multi-user.target /
      # the sandbox's readiness. The sandbox is usable on the base config right away;
      # the converge lands live when it finishes, and the agent polls scooter-env-
      # status. A slow/failed converge no longer blocks startup or the agent's work.
      # The switch this unit's child runs will restart the changed-unit diff — which
      # would include THIS unit — and SIGTERM it. Tell the switch to leave it alone.
      restartIfChanged = false;
      stopIfChanged = false;
      unitConfig.X-StopOnReconfiguration = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${applyModule}/bin/scooter-rebuild-switch switch --detach";
      };
    };
  };
}
