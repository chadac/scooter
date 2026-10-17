# scooter.skillDirs: skill directories installed at /etc/scooter/skills/<name>, where
# the agent's shell runs their scripts and reads their references. The image build
# sets it from the enabled contribs (contrib/skill-dirs.nix); the in-pod re-converge
# sets the same values from the copies baked into the vendored tree
# (contrib-skills/module.nix there), so a self-modify keeps them.
{ config, lib, ... }:

{
  options.scooter.skillDirs = lib.mkOption {
    type = lib.types.attrsOf lib.types.path;
    default = { };
    description = "Skill directories to install at /etc/scooter/skills/<name>.";
  };

  config.environment.etc = lib.mapAttrs'
    (name: src: lib.nameValuePair "scooter/skills/${name}" { source = src; })
    config.scooter.skillDirs;
}
