# Test-VM sizing for the tests that evaluate the WHOLE nixpkgs tree inside the VM
# (`devEnvNix.nixpkgs = "path:${pkgs.path}"`). The kernel derives fs.file-max from
# RAM, so the default 1 GiB test VM caps out around 26k system-wide fds and the
# eval dies with ENFILE ("Too many open files in system") — not a flake, it tracks
# the size of the pinned nixpkgs. Why: PR #516.

{ ... }:

{
  virtualisation.memorySize = 4096;
  boot.kernel.sysctl."fs.file-max" = 524288;
}
