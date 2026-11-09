{ config, lib, buildPkgs, ... }:

# The scheduler image carries the closure of every store path a task run can touch:
# the contrib registry's tasks and scooter-prompt, unioned with this deployment's
# `scooter.systemTasks`. The deployment's contrib tasks are built by the same function
# from the same source as the registry's, so they add nothing: a deployment whose tasks
# are all contrib tasks gets the image `publish-images.yml` built, byte for byte. An
# operator's own task changes the image, so that deployment builds and pushes its own
# scheduler image. A task whose command is still missing at runtime (a ref-only image)
# is logged and skipped by the scheduler.

let
  cfg = config.scooter.config;

  buildContribTasks = import ../../contrib/tasks.nix { inherit lib; inherit (cfg) mkScooterTask; };

  # The strings of a task that carry store paths: its command, and any arg with context.
  storeRefs = command: args: [ command ] ++ lib.filter builtins.hasContext args;

  registryRefs = lib.concatLists (lib.mapAttrsToList
    (_: tasks: lib.concatLists (lib.mapAttrsToList (_: t: storeRefs (lib.getExe t.package) t.args) tasks))
    cfg.contribs.tasks)
    ++ [ (lib.getExe buildPkgs.scooter-prompt) ];

  enabledContribs = lib.filterAttrs (_: c: c.enable) config.contribs;
  deploymentTasks = buildContribTasks enabledContribs;
  deploymentRefs = lib.concatLists (lib.mapAttrsToList (_: t: storeRefs t.command t.args)
    (lib.filterAttrs (_: t: t.enable) config.scooter.systemTasks));
in
{
  scooter.packages.scooter-scheduler = lib.mkDefault (buildPkgs.callPackage ./. { });

  scooter.images.agent-scheduler = {
    package = lib.mkDefault (import ./image.nix {
      inherit lib;
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      scheduler = buildPkgs.scooter-scheduler;
      scooterPrompt = buildPkgs.scooter-prompt;
      refs = registryRefs ++ deploymentRefs;
    });
    attr = "scheduler-image";
    refKey = "scheduler";
    # /tmp is already a volume.
    imageless.writableDirs = [ "/var/run/secrets" ];
    imageless.mountPoints = [ "/tmp" "/data" "/etc/scheduler/system-tasks" ];
  };

  # The deployment's enabled contrib tasks, in the shared task tree.
  # lib.mkDefault on each field, so an operator tunes one with a plain definition.
  scooter.systemTasks = lib.mkMerge (lib.concatLists (lib.mapAttrsToList
    (name: tasks: lib.mapAttrsToList (id: t: {
      "${name}-${id}" = lib.mapAttrs (_: lib.mkDefault) ({
        command = lib.getExe t.package;
        inherit (t) args timezone timeout model;
        contrib = name;
      } // lib.optionalAttrs (t.every != null) { inherit (t) every; }
        // lib.optionalAttrs (t.cron != null) { inherit (t) cron; });
    }) tasks)
    deploymentTasks));
}
