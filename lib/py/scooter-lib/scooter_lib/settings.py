"""Settings every Scooter service (and every contrib) needs to reach the agent-host.

WHY THIS EXISTS. A contrib provider or handler has to know where the agent-host
is — to auto-link a created PR, to spawn a conversation, to build the
"View conversation" deep-link. Today it would get that by importing
`broker.config.settings` / `webhooks.config.settings`, which is the app import
the lib split exists to remove: a contrib cannot depend on the app that loads
it without recreating the build cycle.

So the three agent-host fields are declared HERE, once. The services subclass
this with their own settings, so `broker.config.settings.agent_host_url` and
`webhooks.config.settings.agent_host_url` keep working untouched, and a contrib
constructs its own `AgentHostSettings()` instead of reaching into an app.

WIRE COMPATIBILITY. `env_prefix` is empty and lookup is case-insensitive, so
`agent_host_url` reads `AGENT_HOST_URL` — the same variable `modules/broker.nix`
and `modules/webhooks.nix` already inject. A contrib built on this is
wire-compatible with what is deployed today; no manifest changes, which is what
makes the provider migrations safe to do one at a time.

TWO INSTANCES, NOT ONE. A contrib's `AgentHostSettings()` is a separate object
from the app's settings, reading the same environment. That is fine for values
that come from the environment and do not change at runtime — which these are.
It does mean a test that monkeypatches the APP's settings object does not affect
a contrib's, so a contrib's tests patch (or construct) their own. Called out
because the failure mode otherwise looks like the patch silently not working.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class AgentHostSettings(BaseSettings):
    """Where the agent-host is, and how we authenticate to it."""

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

    model_config = {"env_prefix": "", "case_sensitive": False}
