# The cluster/e2e render's config. CI only; not a public export.
{ lib, scooterSkills, testContribs }:
prefix:
{
  registryPrefix = prefix;
  agent.skills = scooterSkills;
  # Test-only overrides live in modules/testing.nix.
  testing.enable = true;
  # Run the migration Job in the cluster/e2e renders.
  dbMigrate.enable = true;
  # Assets PVC on the single-node k3d hostPath escape hatch.
  conversationController.assets.hostPath = "/var/lib/scooter-e2e-assets";
  # The cross-pod history mirror.
  conversationController.historyMirror = {
    enable = true;
    hostPath = "/var/lib/scooter-e2e-history";
  };
  broker = {
    enable = true;
    # whoami provider for the credential e2e.
    testProvider = true;
  };
  # testWebhook comes from modules/testing.nix.
  webhooks.enable = true;
  # BYOC, so the cluster tier can exercise the tunnel and provider routing.
  # No ingress: it defaults its TLS host to scooter.ingress.host, which is empty
  # here, and the tests reach the controller in-cluster anyway.
  byoc = {
    enable = true;
    ingress.enable = false;
  };
  # A PROVIDER-GROUPED catalog, mirroring production's shape: one model both
  # providers offer, one exclusive to each, and a single global default. Without
  # it the catalog is untagged, the picker renders a flat list, and the grouped
  # branch the provider-routing spec exists to test never renders.
  agent.availableModels = {
    byoc = {
      "model-shared" = { default = true; hint = "Offered by both providers."; };
      "model-byoc-only" = { hint = "byoc exclusive."; };
    };
    claude-code = {
      "model-shared" = { };
      "model-cloud-only" = { hint = "claude-code exclusive."; };
    };
  };
  # Per-conversation service origins, so e2e-full drives the router's sandbox listener
  # and its direct-to-pod path. No DNS or certificate: test/e2e/support/sandboxEdge.mjs
  # plays the wildcard Ingress and Chromium resolves `*.sandbox.e2e.test` to it.
  ingress.sandboxDomain = "sandbox.e2e.test";
  # echo's sample provider, since echo ships to no cluster (skill-providers.spec.ts).
  agent.skillProviders.echo-sample.command = builtins.readFile ../../contrib/echo/skill-provider.sh;
  # e2e configures no credentials; drop contribs needing one.
  # k8s needs none in-cluster: the broker stays on view, writes go as scooter-k8s.
  contribs = testContribs // {
    k8s = {
      enable = true;
      clusters.e2e = {
        auth.inCluster = { };
        defaultNamespace = "agent-sandbox";
        impersonate = {
          user = "scooter-k8s";
          namespaceRoles.agent-sandbox = [ "edit" ];
        };
      };
    };
  };
}
