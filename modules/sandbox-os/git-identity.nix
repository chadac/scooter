# Who the sandbox's commits are by, as the broker says (GET /git/identity): the
# deployment's bot, or in the owner's private conversation the owner, with the bot
# credited in a Co-authored-by trailer.
#
# A poller writes the answer to an included gitconfig, and a global hooks dir adds
# the trailer, running each repo's own hook first. GIT_AUTHOR_* / GIT_COMMITTER_*
# in the pod env override all of this, so a deployment must not set them.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterGitIdentity;
  runDir = "/run/scooter-git";
  identityFile = "${runDir}/identity.gitconfig";
  hooksDir = "/etc/scooter/git-hooks";

  # Every hook a repo may ship, minus reference-transaction (it would spawn a shell on
  # every ref update) and fsmonitor-watchman (configured per repo, not looked up).
  hookNames = [
    "applypatch-msg" "pre-applypatch" "post-applypatch" "pre-commit" "pre-merge-commit"
    "prepare-commit-msg" "commit-msg" "post-commit" "pre-rebase" "post-checkout"
    "post-merge" "pre-push" "pre-receive" "update" "proc-receive" "post-receive"
    "post-update" "push-to-checkout" "pre-auto-gc" "post-rewrite" "sendemail-validate"
    "post-index-change"
  ];

  # core.hooksPath hides .git/hooks, so every hook first runs the repo's own.
  runRepoHook = name: ''
    repo_hook="$(${pkgs.git}/bin/git rev-parse --git-common-dir)/hooks/${name}"
    if [ -x "$repo_hook" ]; then
      "$repo_hook" "$@" || exit $?
    fi
  '';

  hook = name: pkgs.writeShellScript name (''
    set -u
  '' + runRepoHook name + lib.optionalString (name == "prepare-commit-msg") ''
    co="$(${pkgs.git}/bin/git config --get scooter.coauthor || true)"
    case "''${2:-}" in merge|squash) co="" ;; esac
    if [ -n "$co" ]; then
      ${pkgs.git}/bin/git interpret-trailers --in-place --if-exists addIfDifferent \
        --trailer "Co-authored-by: $co" "$1"
    fi
  '');

  poll = pkgs.writeShellScript "scooter-git-identity-poll" ''
    set -u
    env_of() { tr '\0' '\n' < /proc/1/environ | sed -n "s/^$1=//p" | head -1; }
    broker=''${BROKER_URL:-$(env_of BROKER_URL)}
    token_path=''${BROKER_TOKEN_PATH:-$(env_of BROKER_TOKEN_PATH)}
    token_path=''${token_path:-/var/run/secrets/broker/token}
    [ -n "$broker" ] || { echo "no BROKER_URL; nothing to poll"; exec sleep infinity; }
    git=${pkgs.git}/bin/git
    jq=${pkgs.jq}/bin/jq
    while :; do
      if body=$(${pkgs.curl}/bin/curl -sf --max-time 10 \
          -H "Authorization: Bearer $(cat "$token_path" 2>/dev/null)" "''${broker%/}/git/identity"); then
        tmp=$(mktemp ${runDir}/identity.XXXXXX)
        name=$(printf '%s' "$body" | $jq -r '.author.name // empty')
        email=$(printf '%s' "$body" | $jq -r '.author.email // empty')
        co=$(printf '%s' "$body" | $jq -r '.co_author // empty')
        if [ -n "$name" ] && [ -n "$email" ]; then
          $git config --file "$tmp" user.name "$name"
          $git config --file "$tmp" user.email "$email"
        fi
        [ -n "$co" ] && $git config --file "$tmp" scooter.coauthor "$co"
        chmod 0644 "$tmp"
        mv -f "$tmp" ${identityFile}
      fi
      # A failed poll keeps the last answer; credentials are gated in the broker regardless.
      sleep ${toString cfg.interval}
    done
  '';
in
{
  options.programs.scooterGitIdentity = {
    enable = lib.mkEnableOption "commit identity from the broker" // { default = true; };
    interval = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Seconds between polls; how long a visibility change takes to reach git.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.git = {
      enable = true;
      # A missing include is ignored, so git works before the first poll.
      config = {
        include.path = identityFile;
        core.hooksPath = hooksDir;
      };
    };

    environment.etc = lib.listToAttrs (map (n: lib.nameValuePair "scooter/git-hooks/${n}" { source = hook n; }) hookNames);

    systemd.services.scooter-git-identity = {
      description = "Poll the broker for who commits are by";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        ExecStart = poll;
        RuntimeDirectory = "scooter-git";
        RuntimeDirectoryMode = "0755";
        RuntimeDirectoryPreserve = "yes";
        Restart = "always";
        RestartSec = 5;
      };
    };
  };
}
