# Pod wiring for images whose source is imageless: RuntimeClass, release
# annotation and emptyDirs, applied by each workload through `wrapPod`.

{ config, lib, ... }:

let
  cfg = config.scooter;

  volName = dir: "imageless-rw${builtins.replaceStrings [ "/" "." ] [ "-" "-" ] dir}";

  under = parent: path: path == parent || lib.hasPrefix "${parent}/" path;

  emptyDirs = img: map (d: { name = volName d; emptyDir = { }; }) img.imageless.writableDirs;
  dirMounts = img: map (d: { name = volName d; mountPath = d; }) img.imageless.writableDirs;

  # Lists, or attrs keyed by name as kubenix also takes them.
  values = x: if builtins.isList x then x else builtins.attrValues x;
  append = x: extra: if builtins.isList x then x ++ extra
    else x // lib.listToAttrs (map (e: lib.nameValuePair e.name e) extra);

  wrapPod = image: container: template:
    let
      img = cfg.images.${image};
      ctrs = template.spec.containers;
      ctr = if builtins.isList ctrs then lib.findFirst (c: c.name == container) null ctrs else ctrs.${container};
      paths = map (m: m.mountPath) (values (ctr.volumeMounts or [ ]));
      # The root is read-only, so a missing mountpoint fails at create.
      missing = lib.filter
        (p: !(builtins.elem p img.imageless.mountPoints) && !(lib.any (d: under d p) img.imageless.writableDirs))
        paths;
      withMounts = c: c // { volumeMounts = append (c.volumeMounts or [ ]) (dirMounts img); };
    in
    if img.source != "imageless" then template
    else if missing != [ ] then
      throw "scooter.images.${image}: container ${container} mounts ${lib.concatStringsSep ", " missing}; add each to scooter.images.${image}.imageless.mountPoints."
    else
      lib.recursiveUpdate template {
        metadata.annotations = (template.metadata.annotations or { }) // img.pod.annotations // {
          "imageless.run/containers-v1" = container;
        };
        spec = {
          inherit (img.pod) runtimeClassName;
          volumes = append (template.spec.volumes or [ ]) (emptyDirs img);
          containers =
            if builtins.isList ctrs then map (c: if c.name == container then withMounts c else c) ctrs
            else ctrs // { ${container} = withMounts ctr; };
        };
      };

  sandbox = cfg.images.agent-sandbox-os;
in
{
  options.scooter.imageless.wrapPod = lib.mkOption {
    type = lib.types.raw;
    readOnly = true;
    internal = true;
    default = wrapPod;
    description = "image -> container -> pod template -> the template, wired for an imageless image.";
  };

  config = lib.mkIf (sandbox.source == "imageless") {
    scooter.sandboxPod = {
      # The warm Job builds its own pod, without this wiring.
      annotations = if cfg.warmStore.enable
        then throw "scooter.warmStore does not support scooter.images.agent-sandbox-os.source = \"imageless\" yet."
        else sandbox.pod.annotations // { "imageless.run/containers-v1" = "sandbox"; };
      inherit (sandbox.pod) runtimeClassName;
      extraVolumes = emptyDirs sandbox;
      extraVolumeMounts = dirMounts sandbox;
    };
  };
}
