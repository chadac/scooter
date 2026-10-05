# nixosTest: the systemd journal is written to the workspace PVC, early enough to
# hold the records of a boot that crashed.
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
#      -- the whole point: not the layer a container restart discards;
#   2. journald writes there from its first record (Storage=persistent) rather than
#      to /run awaiting systemd-journal-flush, which an early-boot crash never reaches;
#   3. the records are FILES on that filesystem, readable with no journald of their
#      own -- `--file` and `-D`, exactly how the dump reads a dead boot. Asserted
#      across a journald restart, so passing cannot depend on live journald state;
#   4. prior boots are pruned to keepBoots (machine-id is regenerated per container
#      start, so every boot adds a directory journald's own vacuuming ignores);
#   5. activation is idempotent -- `scooter-rebuild switch` re-runs it, and a second
#      bind would stack another mount over the first on every switch;
#   6. with no PVC the boot still SUCCEEDS and says which (node `nopvc`). A sandbox
#      that logs to the container layer is degraded; one that will not boot is broken.
#
# What a VM CANNOT show: that the root layer is destroyed while this filesystem
# survives. That is a property of the deployment (the PVC outlives the container),
# so the testable invariant here is 1 + 3 -- the records are files, on a filesystem
# that is not the root one. True restart durability belongs to the cluster tier.
#
# /workspace is a stage-1 tmpfs, and must be `virtualisation.fileSystems`, NOT
# `fileSystems`: qemu-vm.nix sets `fileSystems = mkVMOverride cfg.fileSystems`
# (priority 10), which discards every normal-priority definition -- a plain
# `fileSystems` entry here vanishes and the VM boots with no /workspace at all,
# which is how the first version of this test failed.
#
# neededForBoot is what makes it a stage-1 mount, i.e. mounted BEFORE the activation
# script runs -- the ordering the kubelet gives the real PVC relative to the
# container's PID 1. systemd.mounts (what overlay-store.nix uses for its tmpfs
# stand-in) cannot serve here: a .mount unit lands after activation has already run.
# A real disk would need x-systemd.makefs, which the scripted initrd in this VM does
# not honour.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-journal-persist";

  nodes = {
    machine = { ... }: {
      imports = [ sandboxModule ];
      boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

      virtualisation.fileSystems."/workspace" = {
        device = "tmpfs";
        fsType = "tmpfs";
        neededForBoot = true;
      };
    };

    # Same config, no /workspace: the degraded path must still reach default.target.
    nopvc = { ... }: {
      imports = [ sandboxModule ];
      boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];
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

    # The bind happens in the activation script, so its report is on the pre-systemd
    # stream -- the console here, the container log in production. That stream being
    # captured, while everything systemd logs afterwards is not, is the whole reason
    # this module exists.
    assert "sandbox-journal: /var/log/journal -> " in machine.get_console_log(), \
        "activation did not report the bind on the pre-systemd stream"

    # --- 2. journald wrote to disk from the start, not /run. -------------------
    machine.succeed("grep -q '^Storage=persistent' /etc/systemd/journald.conf")
    machine.succeed("grep -q '^SystemMaxUse=' /etc/systemd/journald.conf")
    machine.succeed(f"test -n \"$(find {JDIR} -name '*.journal' -print -quit)\"")
    machine.succeed("journalctl -b --no-pager | grep -q .")

    # --- 3. the records are FILES, readable without their own journald. --------
    mid = machine.succeed("cat /etc/machine-id").strip()
    jfile = f"{JDIR}/{mid}/system.journal"
    machine.succeed("systemd-cat -t scooter-probe echo JOURNAL_PROBE_MARKER")
    machine.succeed("journalctl --sync")
    # restart journald so nothing below can be served from its memory: a dump reads
    # a dead boot's files with no journald of their own at all.
    machine.succeed("systemctl restart systemd-journald")
    machine.succeed(f"test -f {jfile}")
    machine.succeed(f"journalctl --no-pager --file {jfile} | grep -q JOURNAL_PROBE_MARKER")
    machine.succeed(f"journalctl --no-pager --directory {JDIR} | grep -q JOURNAL_PROBE_MARKER")
    # -D must also serve --list-boots: --merge reads the same files but is REJECTED
    # alongside --list-boots/-b, so the dump cannot use it. Locking the flag choice in.
    machine.succeed(f"journalctl --no-pager --directory {JDIR} --list-boots | grep -q .")
    machine.fail(f"journalctl --no-pager --merge --directory {JDIR} --list-boots")

    # --- 4. re-activation is idempotent: exactly one mount, never stacked. -----
    # Every `scooter-rebuild switch` re-runs activation with the bind already live.
    # Read the no-op report from the COMMAND's output, not the console. Only the
    # boot-time activation reaches the console (there it is a systemd unit whose
    # stdout IS the console); a manual activate returns its output to the driver.
    reactivation = machine.succeed("/run/current-system/activate 2>&1")
    mounts = int(machine.succeed("grep -c ' /var/log/journal ' /proc/self/mountinfo").strip())
    assert mounts == 1, f"bind stacked {mounts} deep across re-activation"
    assert "already bound" in reactivation, \
        f"re-activation did not report taking the no-op path: {reactivation}"
    machine.succeed("journalctl -b --no-pager | grep -q .")

    # --- 5. prior boots pruned to keepBoots (default 3). -----------------------
    # Unmount FIRST. Prune sits behind the same guard as the bind, so it is reached
    # only when nothing is bound yet -- a container start, which is exactly when a
    # stale boot dir needs collecting. Asserting it with the bind still up tests
    # nothing: activation takes the "already bound" branch and returns first.
    machine.succeed("umount /var/log/journal || umount -l /var/log/journal")
    for i in range(5):
        machine.succeed(f"mkdir -p {JDIR}/fakeboot{i} && touch -d '2020-01-0{i+1}' {JDIR}/fakeboot{i}")
    before = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert before == 6, f"expected 6 dirs before prune, got {before}"

    machine.succeed("/run/current-system/activate")
    after = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert after == 3, f"prune should keep 3, kept {after}"
    # The current boot is the newest, so it must survive: pruning the live journal's
    # own directory would delete the records being written as it ran.
    machine.succeed(f"test -d {JDIR}/{mid}")
    # The same activation re-bound it: a prune must not leave the journal container-local.
    machine.succeed("mountpoint -q /var/log/journal")
    remounts = int(machine.succeed("grep -c ' /var/log/journal ' /proc/self/mountinfo").strip())
    assert remounts == 1, f"re-bind after prune left {remounts} mounts"

    # --- 6. no PVC: degraded, but booted, and it SAYS which. -------------------
    nopvc.wait_for_unit("default.target")
    nopvc.fail("mountpoint -q /var/log/journal")
    assert "sandbox-journal: /workspace is not a mountpoint" in nopvc.get_console_log(), \
        "degraded boot did not report WHY the journal is container-local"
  '';
}
