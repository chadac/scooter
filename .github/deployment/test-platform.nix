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
  # e2e configures no credentials; drop contribs needing one.
  contribs = testContribs;
}
