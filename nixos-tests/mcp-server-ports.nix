# Pure EVAL (no VM): the mcpServers port assertions actually FIRE.
#
# A NixOS assertion with a broken predicate is a silent no-op — it never fails, so
# every VM test stays green while the guarantee is gone. The VM test (mcp-servers.nix)
# proves the happy path; this proves the guard rejects what it claims to.
#
# Reads config.assertions directly rather than building a toplevel: the assertion
# predicates are what is under test, and evaluating them is seconds vs minutes.

{ pkgs, lib, sandboxModule ? null }:

let
  # The whole module dir, not the two files: web-services.nix imports its siblings
  # (./web-services/marimo.nix …), so copying only the file would leave those
  # dangling. Interpolating the DIRECTORY puts the tree in the store, which also
  # keeps this hermetic — a `toString` of the source path would resolve to the
  # checkout and only work in an unsandboxed build.
  moduleDir = ../modules/sandbox-os;
  mcpModule = "${moduleDir}/mcp-servers.nix";
  webModule = "${moduleDir}/web-services.nix";

  # Evaluate a config's FAILED assertion messages, as JSON. Bare eval-config is
  # enough because we never ask for system.build.toplevel.
  failedFor = attrs: ''
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        pkgs = import ${pkgs.path} { system = "x86_64-linux"; };
        eval = (import (${pkgs.path} + "/nixos/lib/eval-config.nix")) {
          system = "x86_64-linux";
          modules = [
            ${mcpModule}
            ${webModule}
            { nixpkgs.pkgs = pkgs; system.stateVersion = "24.11"; }
            ${attrs}
          ];
        };
      in map (a: a.message) (builtins.filter (a: !a.assertion) eval.config.assertions)
    '
  '';

  fakeCmd = "/bin/true";
in
pkgs.runCommand "dev-env-mcp-server-ports"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) Two servers sharing an EXPLICIT port. This is the case auto-assignment can
  #     never produce and the auto-vs-explicit check would never see, so it needs its
  #     own guard.
  dup=$(${failedFor ''
    { mcpServers.a = { enable = true; port = 9800; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; port = 9800; command = "${fakeCmd}"; }; }
  ''})
  echo "dup: $dup"
  echo "$dup" | grep -q "unique ports" || { echo "FAIL: duplicate explicit ports were accepted"; exit 1; }

  # (2) An explicit port that lands on top of an auto-assigned one. "a" sorts first
  #     so it takes the 9700 base; "b" then claims it explicitly.
  clash=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; port = 9700; command = "${fakeCmd}"; }; }
  ''})
  echo "clash: $clash"
  echo "$clash" | grep -q "unique ports" || { echo "FAIL: explicit port colliding with an auto one was accepted"; exit 1; }

  # (3) A port already taken by a WEB service. Both draw from the pod's one port space.
  web=$(${failedFor ''
    { webServices.demo = { enable = true; port = 9700; command = "${fakeCmd}"; };
      mcpServers.a = { enable = true; command = "${fakeCmd}"; }; }
  ''})
  echo "web: $web"
  echo "$web" | grep -q "collide with webServices" || { echo "FAIL: an MCP/webService port collision was accepted"; exit 1; }

  # (4) Exactly one of command/stdioCommand.
  both=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; stdioCommand = "${fakeCmd}"; }; }
  ''})
  echo "both: $both"
  echo "$both" | grep -q "exactly one" || { echo "FAIL: command + stdioCommand together were accepted"; exit 1; }

  neither=$(${failedFor ''{ mcpServers.a = { enable = true; }; }''})
  echo "neither: $neither"
  echo "$neither" | grep -q "exactly one" || { echo "FAIL: neither command nor stdioCommand was accepted"; exit 1; }

  # (5) The HAPPY path must stay clean — a guard that fires on everything is as
  #     useless as one that never fires. Distinct auto ports + an explicit one.
  ok=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; command = "${fakeCmd}"; };
      mcpServers.c = { enable = true; port = 9911; command = "${fakeCmd}"; }; }
  ''})
  echo "ok: $ok"
  if echo "$ok" | grep -qE "unique ports|collide with webServices|exactly one"; then
    echo "FAIL: the happy path tripped an mcpServers assertion: $ok"; exit 1
  fi

  touch $out
''
