"""The settings base every Scooter service and contrib builds on.

WHY THIS EXISTS. A contrib provider or handler needs configuration that the
service also needs — where the agent-host is, so it can auto-link a created PR,
spawn a conversation, or build a "View conversation" deep-link. Today it would
get that by importing `broker.config.settings` / `webhooks.config.settings`,
which is the app import the lib split exists to remove: a contrib cannot depend
on the app that loads it without recreating the build cycle.

So shared configuration is declared HERE, once. The services subclass this with
their own settings, so `broker.config.settings.agent_host_url` and its webhooks
equivalent keep working untouched, and a contrib constructs its own
`ScooterBaseSettings()` instead of reaching into an app.

WHAT BELONGS HERE. Configuration more than one service (or a contrib) genuinely
shares. The agent-host contact fields are the first tenant; the env-reading
convention below — no prefix, case-insensitive — is itself part of the contract,
since it is what makes every service and contrib read the same variable names.
Per-service and per-integration settings do NOT belong here: they stay with
their service, or travel into their contrib.

WIRE COMPATIBILITY. `env_prefix` is empty and lookup is case-insensitive, so
`agent_host_url` reads `AGENT_HOST_URL` — the same variable `modules/broker.nix`
and `modules/webhooks.nix` already inject. A contrib built on this is
wire-compatible with what is deployed today; no manifest changes, which is what
makes the provider migrations safe to do one at a time.

TWO INSTANCES, NOT ONE. A contrib's settings object is separate from the app's,
reading the same environment. That is fine for values that come from the
environment and do not change at runtime — which these are. It does mean a test
that monkeypatches the APP's settings object does not affect a contrib's, so a
contrib's tests patch (or construct) their own. Called out because the failure
mode otherwise looks like the patch silently not working.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class ScooterBaseSettings(BaseSettings):
    """Shared settings + the env-reading convention. Services subclass this."""

    # --- agent-host ---------------------------------------------------------

    # The agent-host base URL. EMPTY IS MEANINGFUL: it means "not configured",
    # and the agent-host clients treat it as a disable switch rather than an
    # error — the broker's auto-linking is off in local/dev for exactly this
    # reason (see scooter_broker_lib.autolink, which returns early on a falsy
    # url). So the default here is "" and NOT the in-cluster URL: defaulting to
    # a real address would silently turn auto-linking ON everywhere the variable
    # is unset, including local runs, and start POSTing to a host that may not
    # exist. A service that wants a real default overrides the field — webhooks
    # does, because spawning a conversation is its whole job and an unset URL
    # there is a misconfiguration rather than a mode.
    agent_host_url: str = ""

    # Projected ServiceAccount token (audience agent-host) presented on /agui so
    # the agent-host can verify the caller via TokenReview and honor a
    # conversation `owner`. Not mounted -> no token -> owner ignored (unowned).
    agent_host_token_path: str = "/var/run/secrets/agent-host/token"

    # Public UI base URL for "View conversation" deep-links posted back to
    # Slack/GitHub/GitLab/Jira: <agent_manager_url>/?thread=<id>. Distinct from
    # agent_host_url, which is the internal API. Empty -> the link degrades to
    # the raw conversation id.
    agent_manager_url: str = ""

    # The env-reading convention, inherited by every service and contrib: no
    # prefix, case-insensitive. This is why a contrib field named
    # `datadog_api_key` reads the DATADOG_API_KEY the manifests already set.
    model_config = {"env_prefix": "", "case_sensitive": False}
