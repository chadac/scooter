{ pkgs, lib }:

# An image's copyToRoot and OCI config as an imageless rootfs and release process.
# The rootfs is a read-only store path, so every mountpoint must already exist in it.

{ name
, copyToRoot ? [ ]
, config ? { }
  # Dirs the pod mounts an emptyDir over.
, writableDirs ? [ ]
  # Dirs a pod volume mounts onto.
, mountPoints ? [ ]
}:

let
  # Mountpoints the runtime and kubelet always use.
  baseDirs = [ "/dev" "/proc" "/sys" "/run" "/nix/store" ];
  baseFiles = [ "/etc/hosts" "/etc/hostname" "/etc/resolv.conf" ];

  dirs = lib.unique (baseDirs ++ writableDirs ++ mountPoints);

  splitEnv = entry:
    let m = builtins.match "([^=]+)=(.*)" entry;
    in { name = builtins.elemAt m 0; value = builtins.elemAt m 1; allow_workload_override = true; };

  # imageless.release.v1 process metadata; the pod's env still wins.
  process = lib.filterAttrs (_: v: v != null && v != [ ]) {
    entrypoint = config.Entrypoint or null;
    default_args = config.Cmd or null;
    working_directory = config.WorkingDir or null;
    environment = map splitEnv (config.Env or [ ]);
  };
  processJson = builtins.toJSON process;
in
{
  rootfs = pkgs.runCommand "${name}-imageless-rootfs" { } ''
    mkdir -p $out
    ${lib.concatMapStrings (p: ''
      cp -rT -P --preserve=mode ${p} $out
      chmod -R u+w $out
    '') (lib.toList copyToRoot)}
    ${lib.concatMapStrings (d: "mkdir -p $out${d}\n") dirs}
    ${lib.concatMapStrings (f: "mkdir -p $(dirname $out${f}) && touch $out${f}\n") baseFiles}
    # Pulls the entrypoint's closure into the rootfs's, for closure projection.
    printf %s ${lib.escapeShellArg processJson} > $out/.imageless-process.json
  '';

  # Context-free, so a manifest's digest costs no build.
  process = builtins.fromJSON (builtins.unsafeDiscardStringContext processJson);
}
