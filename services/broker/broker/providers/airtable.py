"""Airtable provider module — personal access token, http-proxy only.

Proxies /airtable/* -> https://api.airtable.com with the PAT injected as a bearer
header, so the agent can read and write bases WITHOUT ever seeing the token.
Enabled iff a token is configured.

Unlike Grafana (a per-stack URL) the upstream is Airtable's single fixed API
host, so it is hardcoded rather than config.

Typical agent usage — these are the paths the PROXY sees, so they start after
/airtable/:
    GET  v0/meta/bases                      (list bases the PAT can reach)
    GET  v0/meta/bases/{baseId}/tables      (schema: table + field ids)
    GET  v0/{baseId}/{tableIdOrName}        (list records)
    POST v0/{baseId}/{tableIdOrName}        (create records)
"""

from __future__ import annotations

from ..config import settings
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy


@register_provider
def airtable() -> Provider:
    token = (settings.airtable_token or "").strip()
    return Provider(
        name="airtable",
        # Airtable PATs (pat…) are plain bearer tokens, so the default kind is right.
        credential=StaticTokenSource(token=token),
        transports=[HttpProxy(upstream="https://api.airtable.com")],
        enabled=bool(token),
    )
