# nixosTest: the scooter-rebuild entrypoint CLI — the agent's environment interface.
#
# Boots the sandbox-os config and exercises scooter-rebuild's module-authoring workflow
# (new / list / show / rm on /etc/scooter/modules) + the dispatch to the switch/status
# machinery. Does NOT run a full toplevel rebuild (that offline path is covered by
# dev-env-scooter-module + Tier-2); this proves the CLI surface + the /etc/scooter/modules
# file operations against the real symlinked dir.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-rebuild";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    programs.scooterModule.enable = true;
    # The in-pod build isn't exercised here, but the option is required.
    programs.scooterModule.nixpkgs = lib.mkForce "/dev/null";
    programs.scooterModule.applyOnBoot = lib.mkForce false;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # /etc/scooter/modules exists (the tmpfiles symlink -> workspace PVC dir).
    machine.succeed("test -L /etc/scooter/modules")
    machine.succeed("test -d /etc/scooter/modules")

    # list: empty initially -> the "no modules yet" hint (exit 0).
    out = machine.succeed("scooter-rebuild module list")
    assert "no modules yet" in out, f"expected empty hint, got: {out!r}"

    # new: creates modules/<name>.nix from a template on the PVC dir.
    machine.succeed("scooter-rebuild module new mytool")
    machine.succeed("test -f /etc/scooter/modules/mytool.nix")
    # it lands on the real PVC path behind the symlink.
    machine.succeed("test -f /workspace/.scooter/modules/mytool.nix")

    # list now shows it (by bare name).
    listed = machine.succeed("scooter-rebuild module list").strip()
    assert listed == "mytool", f"expected 'mytool', got: {listed!r}"

    # show prints the module contents.
    shown = machine.succeed("scooter-rebuild module show mytool")
    assert "NixOS module" in shown, f"template not shown: {shown!r}"

    # new on an existing name FAILS (don't clobber).
    machine.fail("scooter-rebuild module new mytool")

    # edit: opens $EDITOR on the module file. Use a single-binary editor wrapper (a
    # script that appends a marker) to prove edit targets the right path.
    machine.succeed(
        "printf '#!/bin/sh\\nprintf \"# edited\\\\n\" >> \"$1\"\\n' > /tmp/ed && chmod +x /tmp/ed"
    )
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit mytool")
    machine.succeed("grep -q '# edited' /etc/scooter/modules/mytool.nix")
    # edit on a NON-existent module creates it first (then edits).
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit fresh")
    machine.succeed("test -f /etc/scooter/modules/fresh.nix")
    machine.succeed("scooter-rebuild module rm fresh")

    # path-traversal names are rejected.
    machine.fail("scooter-rebuild module new ../evil")
    machine.fail("scooter-rebuild module show foo/bar")

    # rm deletes it; list is empty again.
    machine.succeed("scooter-rebuild module rm mytool")
    machine.fail("test -e /etc/scooter/modules/mytool.nix")
    assert "no modules yet" in machine.succeed("scooter-rebuild module list")

    # dispatch: status wraps scooter-env-status (idle before any switch -> ready, exit 0).
    st = machine.succeed("scooter-rebuild status")
    assert "ready" in st, f"status not ready: {st!r}"

    # unknown command / subcommand -> usage + non-zero.
    machine.fail("scooter-rebuild bogus")
    machine.fail("scooter-rebuild module bogus")
    # --help prints the command list (exits 2 = usage; capture stderr).
    help = machine.succeed("scooter-rebuild --help 2>&1 || true")
    assert "scooter-rebuild switch" in help, f"help missing commands: {help!r}"
  '';
}
