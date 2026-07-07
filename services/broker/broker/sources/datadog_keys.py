"""Datadog credential source — the two-key header auth Datadog requires.

Datadog authenticates each API request with TWO headers, not one bearer token:
  DD-API-KEY           the org API key
  DD-APPLICATION-KEY   the application key (scopes what the request may read)

So this source emits a "multi-header" Credential carrying both, and the shared
Credential.inject() sets both on the outbound request. The agent never sees
either key — the broker injects them on the proxy hop.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ..core.types import Credential, CredentialSource, Identity


@dataclass
class DatadogKeysSource(CredentialSource):
    api_key: str
    app_key: str

    async def get(self, identity: Identity) -> Credential:
        return Credential(
            kind="multi-header",
            value=json.dumps({
                "DD-API-KEY": self.api_key,
                "DD-APPLICATION-KEY": self.app_key,
            }),
        )
