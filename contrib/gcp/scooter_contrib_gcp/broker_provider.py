"""Google Cloud provider: service-account tokens injected by the forge proxy into calls to *.googleapis.com.

Mounts no routes of its own. The sandbox's gcloud, terraform and curl send a
placeholder token to the real hostnames; the forge proxy intercepts exactly the
hosts in `GcpSettings.hosts`, runs the ForgePolicy and swaps in the real token.
Enabled iff a valid service-account key is configured.
"""

from __future__ import annotations

import json
import logging

from scooter_broker_lib.forge import ForgeHost, ForgeHosts, load_policy
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

from .config import GcpSettings
from .service_account import ServiceAccountSource

logger = logging.getLogger(__name__)


@register_provider
def gcp() -> Provider:
    # Read at build time, once per create_app().
    settings = GcpSettings()
    info = _load_key(settings.gcp_service_account_json)
    try:
        hosts = settings.hosts
    except ValueError as e:
        logger.error("GCP_EXTRA_HOSTS: %s; gcp provider disabled", e)
        hosts, info = [], None
    return Provider(
        name="gcp",
        credential=ServiceAccountSource(info=info or {}, scopes=settings.scopes),
        transports=[ForgeHosts(hosts=[ForgeHost(h, api_prefixes=("/",)) for h in hosts])],
        enabled=info is not None,
        forge_policy=load_policy(settings.gcp_forge_policy),
    )


def _load_key(raw: str) -> dict | None:
    if not raw.strip():
        logger.error("GCP_SERVICE_ACCOUNT_JSON is empty; gcp provider disabled")
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("GCP_SERVICE_ACCOUNT_JSON is not valid JSON; gcp provider disabled")
        return None
    if not isinstance(info, dict) or not info.get("client_email") or not info.get("private_key"):
        logger.error("GCP_SERVICE_ACCOUNT_JSON lacks client_email/private_key; gcp provider disabled")
        return None
    return info
