"""Jira's resource shapes: a browse URL and a bare issue key name the same issue.

Registered into `scooter_webhooks_lib.resources` (#576). A key cannot be widened
into a URL — the site is not in `ENG-42`, and guessing one would point at another
tenant's issue — so a bare key stays itself. Why: PR #582.
"""

from __future__ import annotations

import re

from scooter_webhooks_lib.resources import ResourceShapes, register_resource_shapes

_JIRA_URL_RE = re.compile(r"^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$")


def _id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


register_resource_shapes(
    "jira",
    ResourceShapes(
        type_aliases={"ticket": "issue", "issue": "issue"},
        id_variants=_id_variants,
    ),
)
