# Pure eval (no VM): the mcpServers port assertions actually fire. A NixOS
# assertion with a broken predicate is a silent no-op, so this reads
# config.assertions directly and proves each guard rejects what it claims to.

{ pkgs, lib, sandboxModule ? null }:

let
  # The whole module dir, interpolated into the store, since web-services.nix imports its siblings.
  moduleDir = ../modules/sandbox-os;
  mcpModule = "${moduleDir}/mcp-servers.nix";
  webModule = "${moduleDir}/web-services.nix";

  # Evaluate a config's failed assertion messages as JSON.
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

  # (1) Two servers sharing an explicit port.
  dup=$(${failedFor ''
    { mcpServers.a = { enable = true; port = 9750; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; port = 9750; command = "${fakeCmd}"; }; }
  ''})
  echo "dup: $dup"
  echo "$dup" | grep -q "unique ports" || { echo "FAIL: duplicate explicit ports were accepted"; exit 1; }

  # (2) An explicit port that lands on top of an auto-assigned one.
  clash=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; port = 9700; command = "${fakeCmd}"; }; }
  ''})
  echo "clash: $clash"
  echo "$clash" | grep -q "unique ports" || { echo "FAIL: explicit port colliding with an auto one was accepted"; exit 1; }

  # (3) A web service inside the MCP range, which the router cannot reach.
  web=$(${failedFor ''
    { webServices.demo = { enable = true; port = 9700; command = "${fakeCmd}"; };
      mcpServers.a = { enable = true; command = "${fakeCmd}"; }; }
  ''})
  echo "web: $web"
  echo "$web" | grep -q "reserved for mcpServers" || { echo "FAIL: a web service in the MCP range was accepted"; exit 1; }

  # (4) Exactly one of command/stdioCommand.
  both=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; stdioCommand = "${fakeCmd}"; }; }
  ''})
  echo "both: $both"
  echo "$both" | grep -q "exactly one" || { echo "FAIL: command + stdioCommand together were accepted"; exit 1; }

  neither=$(${failedFor ''{ mcpServers.a = { enable = true; }; }''})
  echo "neither: $neither"
  echo "$neither" | grep -q "exactly one" || { echo "FAIL: neither command nor stdioCommand was accepted"; exit 1; }

  # (5) The happy path must stay clean.
  ok=$(${failedFor ''
    { mcpServers.a = { enable = true; command = "${fakeCmd}"; };
      mcpServers.b = { enable = true; command = "${fakeCmd}"; };
      mcpServers.c = { enable = true; port = 9790; command = "${fakeCmd}"; }; }
  ''})
  echo "ok: $ok"
  if echo "$ok" | grep -qE "unique ports|reserved for mcpServers|exactly one|names may use"; then
    echo "FAIL: the happy path tripped an mcpServers assertion: $ok"; exit 1
  fi

  # (6) A name that cannot appear in a tool name.
  badname=$(${failedFor ''{ mcpServers."my.server" = { enable = true; command = "${fakeCmd}"; }; }''})
  echo "badname: $badname"
  echo "$badname" | grep -q "names may use" || { echo "FAIL: a name with '.' was accepted"; exit 1; }

  # (7) An explicit port outside the range only the agent-host can reach.
  outside=$( { ${failedFor ''{ mcpServers.a = { enable = true; port = 9800; command = "${fakeCmd}"; }; }''} } 2>&1 || true)
  echo "outside: $outside"
  echo "$outside" | grep -q "between 9700 and 9799" || { echo "FAIL: a port outside the MCP range was accepted"; exit 1; }

  # (8) The manifest is rendered even with nothing declared, so absent means unreadable.
  rules=$(nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
    let pkgs = import ${pkgs.path} { system = "x86_64-linux"; };
    in ((import (${pkgs.path} + "/nixos/lib/eval-config.nix")) {
      system = "x86_64-linux";
      modules = [ ${mcpModule} ${webModule} { nixpkgs.pkgs = pkgs; system.stateVersion = "24.11"; } ];
    }).config.systemd.tmpfiles.rules
  ')
  echo "rules: $rules"
  echo "$rules" | grep -q "/run/scooter/mcp-servers.json" || { echo "FAIL: no manifest rendered when no server is declared"; exit 1; }

  touch $out
''
