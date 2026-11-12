"""Atlassian settings, owned by this contrib; contrib/jira reads the same client from the broker's env."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings

API_HOST = "api.atlassian.com"

# product -> its API root on API_HOST
PRODUCTS = {
    "jira": "/ex/jira/{cloud_id}/",
    "confluence": "/ex/confluence/{cloud_id}/",
}


class AtlassianSettings(ScooterBaseSettings):
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""
    # e.g. https://acme.atlassian.net; builds /browse/{KEY} links.
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
