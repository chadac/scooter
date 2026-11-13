# The single-machine preset behind `nix run .#local` (docs/tutorial/local.md): one
# user on a trusted machine, a single-node cluster (k3d) with no auth proxy, no RWX
# storage and no ingress controller beyond k3s's Traefik, and the published images.
#
# Import it from a deployment's own module too (`imports = [ scooter.kubenixModules.local ]`);
# every setting is a `mkDefault`, so the deployment's values win.
{ config, lib, ... }:
let
  inherit (lib) mkOption mkDefault types literalExpression;
  cfg = config.scooter.local;

  # The claude-code provider's catalog, by capability.
  claudeModels = {
    "claude-opus-5-5" = { default = true; hint = "Capable and fast enough for most work."; };
    "claude-sonnet-5-5" = { hint = "Fast: simple edits, config fixes, small PRs."; };
    "claude-haiku-5-5" = { hint = "Fastest and cheapest: quick lookups, trivial edits."; };
    "claude-fable-5-1" = { hint = "Most capable, slowest: the hardest reasoning and long agentic work."; };
  };

  # The github_copilot provider's catalog: Copilot's own (dotted) ids. Which of them a
  # seat may use is GitHub's policy. goose streams GPT replies but not Claude's through
  # Copilot (those arrive as one block per turn), so a GPT model is the default.
  copilotModels = {
    "gpt-5.4" = { default = true; hint = "Capable and fast enough for most work; streams."; };
    "claude-sonnet-4.6" = { hint = "Fast: simple edits, config fixes, small PRs. Answers arrive in one block."; };
    "claude-opus-4.7" = { hint = "Most capable, slowest: the hardest reasoning. Answers arrive in one block."; };
  };

in
{
  options.scooter.local = {
    provider = mkOption {
      type = types.enum [ "claude-code" "anthropic" "ollama" "copilot" ];
      default = "claude-code";
      description = ''
        Which model provider the preset configures: `claude-code` (a Claude
        subscription token, the agent-host-claude image), `anthropic` (an Anthropic
        API key through goose), `ollama` (a server on the host through goose) or
        `copilot` (a GitHub Copilot seat, through goose's github_copilot provider).
      '';
    };
    agentHostClaudeTag = mkOption {
      type = types.str;
      default = "@AGENT_HOST_CLAUDE_TAG@";
      description = ''
        The published `agent-host-claude` tag for the `claude-code` provider. The
        default is a placeholder that `scooter-local up` replaces with the tag it
        resolves for this revision; a deployment importing the preset sets the tag
        (see "Running on a Claude subscription" in the deploy docs).
      '';
    };
    anthropic.secret = mkOption {
      type = types.str;
      default = "agent-anthropic-key";
      description = "For the `anthropic` provider: the Secret holding the API key under `api-key`.";
    };
    copilot.secret = mkOption {
      type = types.str;
      default = "agent-copilot-token";
      description = ''
        For the `copilot` provider: the Secret holding a GitHub token of a user with a
        Copilot seat under `token`. goose exchanges it for a Copilot API token.
      '';
    };
    ollama = {
      host = mkOption {
        type = types.str;
        default = "@OLLAMA_HOST@";
        example = "http://host.k3d.internal:11434";
        description = ''
          For the `ollama` provider: the server URL as seen from inside the cluster.
          The default is a placeholder scooter-local fills in (k3d's host alias).
        '';
      };
      model = mkOption {
        type = types.str;
        default = "@OLLAMA_MODEL@";
        example = "qwen2.5-coder:7b";
        description = ''
          For the `ollama` provider: the model id. The default is a placeholder
          scooter-local fills in with the model chosen at `up`.
        '';
      };
    };
    assetsHostPath = mkOption {
      type = types.str;
      default = "/var/lib/scooter/assets";
      description = ''
        Host directory on the single node backing the agent-host's assets volume
        (the platform's `conversationController.assets.hostPath` escape hatch);
        scooter-local bind-mounts its state directory there.
      '';
    };
  };

  config = {
    scooter = lib.mkMerge [
      {
        namespace = mkDefault "scooter";
        ui.enable = mkDefault true;
        broker.enable = mkDefault true;

        # SECURITY: one user on their own machine. The router trusts whatever identity
        # header arrives (none: the `anonymous` user), so this must only ever be
        # reachable from that machine; scooter-local binds the port to 127.0.0.1.
        auth.enforce = mkDefault false;

        # k3s ships Traefik, and a host-less rule is a catch-all, so the stock Ingress
        # serves http://localhost:<port> with nothing else installed.
        ingress = {
          enable = mkDefault true;
          className = mkDefault "traefik";
        };

        # One of everything.
        replicas = mkDefault 1;
        statelessReplicas = mkDefault 1;
        conversationController = {
          replicas = mkDefault 1;
          routerReplicas = mkDefault 1;
          # The controller autoscales agent-host from a warm fleet of two; here one pod
          # serves up to podCap conversations before a second is worth its memory.
          minReplicas = mkDefault 1;
          # No RWX provisioner on a single node: hostPath for the assets volume, and
          # no history mirror (conversation history lives in Postgres).
          assets.hostPath = mkDefault cfg.assetsHostPath;
          historyMirror.enable = mkDefault false;
        };

        # Sized for a laptop; the agent can still ask for `medium`.
        sandboxSizes = mkDefault {
          small = { cpu = "1"; memory = "2Gi"; hint = "Scripts, small repos."; default = true; };
          medium = { cpu = "2"; memory = "4Gi"; hint = "Builds and test suites."; };
        };
        idleSuspendMs = mkDefault (30 * 60 * 1000);

        agent.name = mkDefault "Scooter";
      }
      # The in-cluster Claude Code SDK on a subscription token (`claude setup-token`).
      (lib.mkIf (cfg.provider == "claude-code") {
        agent = {
          provider = mkDefault "claude-code";
          claudeCode.tokenSecret = mkDefault "agent-claude-code-token";
          availableModels.claude-code = mkDefault claudeModels;
        };
        # The claude CLI is unfree, so the platform cannot pick this image (or compute
        # its tag) itself; scooter-local fills the tag in at `up` (issue #824).
        images.agent-host.ref = {
          image = mkDefault "${config.scooter.registryPrefix}agent-host-claude";
          tag = lib.mkOverride 20 cfg.agentHostClaudeTag;
        };
      })
      # goose's Anthropic provider on an API key.
      (lib.mkIf (cfg.provider == "anthropic") {
        agent = {
          provider = mkDefault "anthropic";
          secretEnv.ANTHROPIC_API_KEY = mkDefault { secret = cfg.anthropic.secret; key = "api-key"; };
          availableModels.goose = mkDefault claudeModels;
        };
      })
      # goose's Ollama provider against a server on the host.
      (lib.mkIf (cfg.provider == "ollama") {
        agent = {
          provider = mkDefault "ollama";
          env.OLLAMA_HOST = mkDefault cfg.ollama.host;
          availableModels.goose.${cfg.ollama.model} = mkDefault {
            default = true;
            hint = "The local Ollama model.";
          };
        };
      })
      # goose's GitHub Copilot provider on a seat's GitHub token. goose keeps the
      # exchanged Copilot token under the agent-host's $HOME (an emptyDir), never in a
      # sandbox; a rollout wipes it and goose exchanges again on the next launch.
      (lib.mkIf (cfg.provider == "copilot") {
        agent = {
          provider = mkDefault "github_copilot";
          secretEnv.GITHUB_COPILOT_TOKEN = mkDefault { secret = cfg.copilot.secret; key = "token"; };
          availableModels.copilot = mkDefault copilotModels;
        };
      })
    ];

    # The contribs that need no credentials.
    contribs = {
      ask-user.enable = mkDefault true;
      commits.enable = mkDefault true;
      duckduckgo.enable = mkDefault true;
      files.enable = mkDefault true;
      handoff.enable = mkDefault true;
      personalization.enable = mkDefault true;
      shares.enable = mkDefault true;
      skills.enable = mkDefault true;
    };
  };
}
