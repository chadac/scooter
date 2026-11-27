# The Agent panel bridge (launch.py, agent-panel.js) against the marimo the service pins.
{ pkgs, lib }:

let
  python = pkgs.python3.withPackages (ps: [ ps.marimo ]);
in
assert lib.assertMsg (python.pkgs.marimo.version == pkgs.marimo.version)
  "check.nix must test the marimo version sandbox.nix pins";
pkgs.runCommand "marimo-agent-panel-check" {
  nativeBuildInputs = [ python pkgs.curl ];
} ''
  bash ${../notebook/check-agent-panel.sh} ${../notebook/launch.py}
  touch $out
''
