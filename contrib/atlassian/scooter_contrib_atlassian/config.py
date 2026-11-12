"""Atlassian settings, owned by this contrib; contrib/jira reads the same client from the broker's env."""

from __future__ import annotations

from urllib.parse import urlsplit

from scooter_lib.settings import ScooterBaseSettings

API_HOST = "api.atlassian.com"
TOKEN_URL = "https://auth.atlassian.com/oauth/token"

# product -> (API root on API_HOST, site prefix mapped onto it)
PRODUCTS = {
    "jira": ("/ex/jira/{cloud_id}/", "/rest/"),
    "confluence": ("/ex/confluence/{cloud_id}/", "/wiki/"),
}


class AtlassianSettings(ScooterBaseSettings):
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""
    # e.g. https://acme.atlassian.net; empty intercepts api.atlassian.com only.
    atlassian_site_url: str = ""
    # Space-separated PRODUCTS keys whose paths get the token.
    atlassian_products: str = "jira confluence"
    atlassian_forge_policy: str = ""

    @property
    def products(self) -> list[str]:
        names = self.atlassian_products.replace(",", " ").split()
        unknown = sorted(set(names) - PRODUCTS.keys())
        if unknown:
            raise ValueError(f"unknown Atlassian products {unknown}; known: {sorted(PRODUCTS)}")
        return [p for p in PRODUCTS if p in names]

    @property
    def site_host(self) -> str | None:
        raw = self.atlassian_site_url.strip()
        if not raw:
            return None
        url = urlsplit(raw if "://" in raw else f"https://{raw}")
        if url.scheme != "https" or not url.hostname or url.path.strip("/"):
            raise ValueError(f"ATLASSIAN_SITE_URL {raw!r} is not an https site root")
        return url.hostname.lower()
