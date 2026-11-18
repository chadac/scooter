"""apikeys settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class ApiKeysSettings(ScooterBaseSettings):
    apikeys_enabled: bool = False
    # Comma-separated ServiceAccounts allowed to call /verify: webhooks.
    apikeys_verifier_service_accounts: str = ""
    # Audience of the verifier's projected token.
    apikeys_token_audience: str = "agent-broker"
