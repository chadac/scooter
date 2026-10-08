# A production-shaped render, as an eval-time canary. CI only.
{ scooterSkills, testContribs }:
{
  agent.skills = scooterSkills;
  # The real agent: this is a production deploy.
  fakeAgent = false;
  broker.enable = true;
  # No testWebhook -- /webhooks/test is e2e-only.
  webhooks.enable = true;
  contribs = testContribs;
}
