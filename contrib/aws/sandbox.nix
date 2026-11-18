# aws's sandbox half: the agent-facing CLIs, the aws-cli stub, and the boot-time
# ~/.aws/config render.
{ config, lib, pkgs, ... }:

let
  # The agent's home, shared with carry-over so the two cannot drift apart.
  home = config.programs.scooterCarryOver.home;

  # cli.py embedded verbatim, so the in-sandbox helper cannot drift from the
  # service that answers it.
  cliPy = pkgs.writeTextFile {
    name = "scooter_aws_cli.py";
    destination = "/lib/scooter_aws_cli.py";
    text = builtins.readFile ./scooter_contrib_aws/cli.py;
  };

  # Two console entries over one module via run_path, so the sandbox needs only python3.
  awsTool = { name, entry }: pkgs.writeShellApplication {
    inherit name;
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 -c 'import runpy,sys; m=runpy.run_path("${cliPy}/lib/scooter_aws_cli.py"); sys.exit(m["${entry}"](sys.argv[1:]))' "$@"
    '';
  };

  # The request/approval CLI the agent drives (see skills/scooter-aws.md).
  scooter-aws = awsTool { name = "scooter-aws"; entry = "cli_main"; };
  # The credential_process helper each ~/.aws/config profile points at.
  scooter-aws-credentials = awsTool {
    name = "scooter-aws-credentials";
    entry = "credentials_main";
  };
in
{
  environment.systemPackages = [
    scooter-aws
    scooter-aws-credentials
    # A nix-stubs shim (./stubs.nix): the real aws-cli materialises
    # into the writable store on the agent's first `aws`.
    pkgs.awscli2
  ];

  # Render ~/.aws/config from the mounted accounts ConfigMap (AWS_ACCOUNTS_FILE is
  # read from PID 1's environ); a sandbox with no accounts mounted has no profiles.
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
