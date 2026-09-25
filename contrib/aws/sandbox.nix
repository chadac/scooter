# aws's sandbox half: the agent-facing CLIs, the aws-cli stub, and the boot-time
# ~/.aws/config render.
#
# This is a RELOCATION, not a rewrite — same scripts, same unit, same stub. It sat
# in modules/sandbox-os/carry-over.nix and pkgs/broker-tools because a contrib had
# no way to reach the sandbox image before #607. See #599.
{ config, lib, pkgs, ... }:

let
  # Written where the AGENT's git/aws read, not where systemd PID 1 thinks HOME is.
  # One declaration for both consumers (carry-over writes .gitconfig against it),
  # so the two cannot drift apart.
  home = config.programs.scooterCarryOver.home;

  # The broker's own cli.py, embedded verbatim: the in-sandbox helper cannot drift
  # from the service that answers it. The reach across trees is temporary — cli.py
  # moves in here with the rest of aws's Python, and then this is `./cli.py`.
  cliPy = pkgs.writeTextFile {
    name = "scooter_aws_cli.py";
    destination = "/lib/scooter_aws_cli.py";
    # The CLI source is THIS contrib's now. Until #599 this reached back into
    # services/broker for it — a sandbox half depending on the app it left.
    text = builtins.readFile ./scooter_contrib_aws/cli.py;
  };

  # Two console entries over one module, matching cli.py's own `cli_main` /
  # `credentials_main`. run_path rather than an installed package: the sandbox
  # needs no aws Python environment, just python3.
  awsTool = { name, entry }: pkgs.writeShellApplication {
    inherit name;
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 -c 'import runpy,sys; m=runpy.run_path("${cliPy}/lib/scooter_aws_cli.py"); sys.exit(m["${entry}"](sys.argv[1:]))' "$@"
    '';
  };

  # scooter-aws: the request/approval CLI the agent drives (see skills/scooter-aws.md).
  scooter-aws = awsTool { name = "scooter-aws"; entry = "cli_main"; };
  # scooter-aws-credentials: the credential_process helper ~/.aws/config points each
  # profile at, so plain `aws --profile <account>` works once a grant is active.
  scooter-aws-credentials = awsTool {
    name = "scooter-aws-credentials";
    entry = "credentials_main";
  };
in
{
  environment.systemPackages = [
    scooter-aws
    scooter-aws-credentials
    # awscli2 (+ its python closure) is ~449 MB — too heavy to bake for a tool most
    # conversations never use. modules/sandbox-os/stubs.nix declares it, so this is a
    # nix-stubs SHIM: the image carries the build recipe and the real aws-cli
    # materialises into the writable store on the agent's first `aws`. The
    # credential_process helper above is python and stays eager.
    pkgs.awscli2
  ];

  # Render ~/.aws/config from the mounted accounts ConfigMap, one [profile <name>]
  # per account wired to the credential_process helper. AWS_ACCOUNTS_FILE comes from
  # the container env, which systemd PID 1 keeps in its environ (only HOME is reset).
  # Best-effort: a sandbox with no accounts mounted simply has no aws profiles.
  systemd.services.scooter-aws-config = {
    description = "Render ~/.aws/config from the accounts ConfigMap";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      accts=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^AWS_ACCOUNTS_FILE=//p' | head -1)
      accts="''${accts:-/etc/agent-sandbox/aws/accounts.json}"
      if [ -r "$accts" ]; then
        mkdir -p ${lib.escapeShellArg "${home}/.aws"}
        if ${scooter-aws-credentials}/bin/scooter-aws-credentials --render-config "$accts" > ${lib.escapeShellArg "${home}/.aws/config"} 2>/dev/null; then
          echo "rendered ${home}/.aws/config from $accts"
        fi
      fi
    '';
  };
}
