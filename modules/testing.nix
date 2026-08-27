# TEST-ONLY overrides — everything a cluster/e2e run needs and a production deploy must never get.
#
# Test-only overrides isolated from production modules to avoid conditional complexity.
#
#   1. Production config was written as the NEGATIVE of a test flag. Reading platform.nix, the
#      real agent's provider/region/OAuth token/model catalog were all conditional on "not
#      testing" — so the production path was the harder one to see, and a mistake in a guard
#      silently changes what a real deploy ships.
#   2. Nothing stopped a production render from setting them. `fakeAgent = true` in a deploy
#      config would swap the real agent for a dummy that answers every prompt with canned text,
#      and nothing in the module system would object.
#
# INVERTED HERE. Production modules now declare production config UNCONDITIONALLY. This module is
# imported only by test renders and OVERRIDES what a test needs (`lib.mkForce`), so:
#
#   - platform.nix reads as what a real deploy gets, with no test branches;
#   - a test render opts IN by importing this module — a deploy that never imports it CANNOT
#     accidentally enable a dummy agent or an unauthenticated test webhook;
#   - every test-only affordance is in one file, so "what does a test change?" has one answer.
#
# Import it from a test manifest ONLY:
#   platform = mkPlatform { imports = [ ./modules/testing.nix ]; agentSandbox.testing.enable = true; … }

{ config, lib, ... }:

let
  cfg = config.agentSandbox;
  tcfg = cfg.testing;
in
{
  options.agentSandbox.testing = with lib; {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Turn on TEST-ONLY behaviour. Never set this on a deploy: it swaps the real ACP agent for a
        dummy that returns canned replies, and can expose unauthenticated test endpoints.
      '';
    };

    fakeAgent = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Run the bundled dummy ACP agent (GOOSE_BIN=fake) instead of a real model. The cluster and
        e2e suites need this: they assert on the AG-UI event stream and sandbox behaviour, not on
        model output, and a real model would make them slow, costly, and nondeterministic.
      '';
    };

    testWebhook = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Expose /webhooks/test — an UNAUTHENTICATED conversation-spawning endpoint for the
        spawn-from-webhook e2e. Provider routes verify signatures; this one cannot, which is
        exactly why it is confined to this module.
      '';
    };
  };

  config = lib.mkIf tcfg.enable {
    # mkForce, because these deliberately override whatever the production modules computed.
    # Anything a test needs to CHANGE about a real deploy belongs here and only here.
    agentSandbox = {
      fakeAgent = lib.mkForce tcfg.fakeAgent;
      webhooks.testWebhook = lib.mkForce tcfg.testWebhook;
      # SMALL sandboxes. The production default is Guaranteed QoS 2cpu/4Gi PER
      # sandbox. Tests assert behaviour, not perf isolation: a fake agent's
      # echo + a short shell command fit comfortably here, and several sandboxes
      # must be schedulable side by side. REQUESTS are near-zero (scheduling
      # density is the whole point); LIMITS stay real because the sandbox is a
      # genuine systemd NixOS pod even under the fake agent — a tiny memory LIMIT
      # would OOM-kill it at boot, and limits (not requests) are what kill.
      sandboxResources = lib.mkForce {
        requests = { cpu = "50m"; memory = "64Mi"; };
        limits = { cpu = "1"; memory = "1Gi"; };
      };
    };

    # A loud marker on every rendered object, so a manifest built with test overrides is
    # identifiable at a glance (and greppable in CI) rather than looking like a real deploy.
    kubernetes.resources.configMaps.agent-testing-marker = {
      metadata = {
        name = "agent-testing-marker";
        namespace = cfg.namespace;
        labels."app.kubernetes.io/component" = "testing";
      };
      data = {
        warning = "This namespace was rendered with agentSandbox.testing.enable = true. NOT a production deploy.";
        fakeAgent = lib.boolToString tcfg.fakeAgent;
        testWebhook = lib.boolToString tcfg.testWebhook;
      };
    };
  };
}
