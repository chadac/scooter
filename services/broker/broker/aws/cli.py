"""Sandbox-side AWS tools — credential_process helper + request CLI.

DESIGN BOILERPLATE. These ship in the SANDBOX image (not the broker pod) and call
the broker with the pod's projected SA token (same auth as agent-broker.sh:
BROKER_URL + /var/run/secrets/broker/token). Two entry points:

  scooter-aws-credentials --profile <name>
      AWS credential_process helper. Resolves <profile> -> account -> the
      conversation's ACTIVE permission request, prints the credential_process
      JSON. If no active grant: exit non-zero with a verbose, actionable error
      (how to run `scooter-aws request …`). No caching.

  scooter-aws <request|status|accounts|revoke> …
      The request/management CLI the agent (via a skill) uses to ASK for access.

~/.aws/config is generated at sandbox start (entrypoint) from the account
ConfigMap: one [profile <name>] per enabled account, each with
  credential_process = scooter-aws-credentials --profile <name>
"""

from __future__ import annotations


# --- credential_process helper ------------------------------------------
def credentials_main(argv: list[str] | None = None) -> int:
    """Entry point for `scooter-aws-credentials --profile <name>`.

    Success: print {"Version":1,"AccessKeyId","SecretAccessKey","SessionToken",
    "Expiration"} to stdout, return 0.
    No active grant / pending / denied / expired: write the verbose
    how-to-request message to stderr, return non-zero (fail closed). No cache.
    """
    raise NotImplementedError


# --- request / management CLI -------------------------------------------
def cli_main(argv: list[str] | None = None) -> int:
    """Entry point for `scooter-aws`.

    Subcommands:
      request  --profile <name> (--policy <file|-> | --managed <arn>...) --justification "…"
               -> POST /aws/request; print request_id + status.
      status   <request_id>     -> GET /aws/{id}; print status (+ note when active).
      accounts                  -> GET /aws/accounts; list the profiles/bounds.
      revoke   <request_id>     -> DELETE /aws/{id}.
    """
    raise NotImplementedError


# --- helpers (shared) ----------------------------------------------------
def render_aws_config(account_registry: dict[str, dict], *, helper_path: str = "scooter-aws-credentials") -> str:
    """Render ~/.aws/config: one [profile <name>] per ENABLED account, each with
    `credential_process = {helper_path} --profile <name>` (+ region). Generated at
    sandbox start from the account ConfigMap — no static keys, single source of
    truth with the broker's registry.
    """
    raise NotImplementedError
