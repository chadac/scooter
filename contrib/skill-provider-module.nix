# One skill provider, shared by scooter.agent.skillProviders and contribs.
{ lib }:
{ name, ... }:
let
  inherit (lib) mkOption types;
in
{
  options = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = "Run this provider in every conversation.";
    };
    command = mkOption {
      type = types.lines;
      example = lib.literalExpression ''"my-skills dump"'';
      description = ''
        A bash script, run as `bash -c` in /workspace inside the sandbox before each agent
        run, with `{"conversation_id", "owner"}` on stdin. It prints
        `{"skills": [{"name", "content", "dir"?}]}`: `content` is a whole SKILL.md, and
        `dir` is the sandbox directory its relative paths resolve against. A provided skill
        never replaces a deployment or personal skill of the same name.
      '';
    };
    timeout = mkOption {
      type = types.ints.positive;
      default = 30;
      description = "Seconds before the command is killed and its last answer kept.";
    };
    wait = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      description = ''
        Seconds a message waits for the command, at most `timeout` (the default). A slower
        answer is kept and offered from a later message.
      '';
    };
    description = mkOption {
      type = types.str;
      default = "";
      description = "One line on what this provider offers.";
    };
  };
}
