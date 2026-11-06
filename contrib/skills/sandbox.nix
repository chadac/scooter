# scooter-skills: lists, dumps and syncs the sandbox's ~/.scooter/skills.
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterSkills;
  # The stub shim keeps Node's closure out of the image.
  node = pkgs.scooter-node or pkgs.nodejs;

  scooterSkills = pkgs.writeShellApplication {
    name = "scooter-skills";
    runtimeInputs = with pkgs; [ coreutils findutils gawk jq git node util-linux ];
    text = ''
      SKILLS_CLI_VERSION=${lib.escapeShellArg cfg.skillsCliVersion}
    '' + builtins.readFile ./scooter-skills.sh;
  };
in
{
  options.programs.scooterSkills.skillsCliVersion = lib.mkOption {
    type = lib.types.str;
    default = "1.7.6";
    description = ''
      The skills.sh CLI (`npx skills`) version that installs `skills.sh` skill sources.
      Pinned so an upstream release cannot change what a sync installs.
    '';
  };

  config.environment.systemPackages = [ scooterSkills ];
}
