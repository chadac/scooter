# nixosTest: the systemd journal lands on the workspace PVC, early enough and
# durably enough to explain a boot that crashed.
#
# The bug this locks down: systemd PID 1 reopens its own stdio on /dev/null and logs
# only to the journal, so a sandbox's container log ends at stage-2's "starting
# systemd..." whether the boot succeeded or died. The journal is the only account of
# what happened -- and by default it sits in the container's overlay layer, which the
# restart destroys. Every dump of a crashed sandbox was reading a stream that could
# not contain the answer. Why: PR #703.
#
# Asserted here:
#   1. /var/log/journal is bound to the PVC path, on a DIFFERENT device than /
#      (the whole point: not the container layer);
#   2. journald writes there from its first record (Storage=persistent) rather than
#      to /run awaiting systemd-journal-flush, which an early-boot crash never reaches;
#   3. a journal FILE on the PVC is readable on its own, with no live journald --
#      exactly how the dump must read a dead boot's records;
#   4. prior boots are pruned to keepBoots (machine-id is regenerated per container
#      start, so every boot adds a directory journald's own vacuuming ignores);
#   5. activation is idempotent -- `scooter-rebuild switch` re-runs it, and a second
#      bind would stack another mount over the first on every switch.
#
# /workspace is a neededForBoot tmpfs here so it is mounted in stage-1, BEFORE
# activation -- the same ordering the kubelet gives the real PVC relative to PID 1.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-journal-persist";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    fileSystems."/workspace" = {
      device = "tmpfs";
      fsType = "tmpfs";
      neededForBoot = true;
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    JDIR = "/workspace/.scooter/journal"

    def dev(p):
        return machine.succeed(f"stat -c %d {p}").strip()

    # --- 1. bound to the PVC, NOT the container/root layer. --------------------
    machine.succeed("mountpoint -q /var/log/journal")
    assert dev("/var/log/journal") == dev(JDIR), "journal not backed by the PVC path"
    assert dev("/var/log/journal") != dev("/"), "journal still on the root layer"

    # --- 2. journald wrote to disk from the start, not /run. -------------------
    machine.succeed("grep -q '^Storage=persistent' /etc/systemd/journald.conf")
    machine.succeed("grep -q '^SystemMaxUse=' /etc/systemd/journald.conf")
    machine.succeed(f"test -n \"$(find {JDIR} -name '*.journal' -print -quit)\"")
    machine.succeed("journalctl -b --no-pager | grep -q .")

    # --- 3. a journal file reads standalone -- how the dump reads a DEAD boot. -
    mid = machine.succeed("cat /etc/machine-id").strip()
    jfile = f"{JDIR}/{mid}/system.journal"
    machine.succeed(f"test -f {jfile}")
    machine.succeed(f"journalctl --no-pager --file {jfile} | grep -q .")
    # and the whole directory merges, which is what `journalctl -m -D` must do
    # across the differing machine-ids of successive boots.
    machine.succeed(f"journalctl --no-pager --directory {JDIR} | grep -q .")
    # -D must also serve --list-boots: --merge reads the same files but is rejected
    # alongside --list-boots/-b, so the dump cannot use it. Locking the flag choice in.
    machine.succeed(f"journalctl --no-pager --directory {JDIR} --list-boots | grep -q .")
    machine.fail(f"journalctl --no-pager --merge --directory {JDIR} --list-boots")

    # --- 4. prior boots pruned to keepBoots (default 3). ----------------------
    for i in range(5):
        machine.succeed(f"mkdir -p {JDIR}/fakeboot{i} && touch -d '2020-01-0{i+1}' {JDIR}/fakeboot{i}")
    before = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert before == 6, f"expected 6 dirs before prune, got {before}"

    machine.succeed("/run/current-system/activate")
    after = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert after == 3, f"prune should keep 3, kept {after}"
    # the CURRENT boot is the newest, so it must be one of the survivors.
    machine.succeed(f"test -d {JDIR}/{mid}")

    # --- 5. activation is idempotent: exactly one mount, never stacked. --------
    mounts = int(machine.succeed("grep -c ' /var/log/journal ' /proc/self/mountinfo").strip())
    assert mounts == 1, f"bind stacked {mounts} deep across re-activation"
    machine.succeed("journalctl -b --no-pager | grep -q .")
  '';
}
