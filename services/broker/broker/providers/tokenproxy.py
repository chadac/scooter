"""Providers declared in Nix as `contribs.<name>.type = "tokenproxy"`: one HTTPS API and its token.

Each is built from TOKENPROXY_PROVIDERS at import, keyed by the contrib's name, and
re-reads its token from the mounted Secret on every request.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

from scooter_broker_lib.forge import ForgeHost, ForgeHosts
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.file_token import FileTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Provider

from ..config import settings


def tokenproxy_provider(name: str, spec: dict, tokens_dir: str, agent_host_url: str = "") -> Provider:
    url = str(spec["url"]).rstrip("/")
    cred = spec.get("credential") or {}
    return Provider(
        name=name,
        credential=FileTokenSource(
            Path(tokens_dir) / name / "token",
            kind=cred.get("kind", "bearer"),
            header_name=cred.get("headerName"),
        ),
        transports=[
            ForgeHosts(hosts=[ForgeHost(urlsplit(url).hostname or "", api_prefixes=tuple(spec["apiPrefixes"]))]),
            HttpProxy(upstream=url, agent_host_url=agent_host_url),
        ],
    )


def _register(name: str, spec: dict) -> None:
    def factory() -> Provider:
        return tokenproxy_provider(name, spec, settings.tokenproxy_dir, settings.agent_host_url)

    # Its own key space, so a reload replaces it and it can never replace a built-in.
    factory.__name__ = f"tokenproxy:{name}"
    register_provider(factory)


for _name, _spec in json.loads(settings.tokenproxy_providers or "{}").items():
    _register(_name, _spec)
