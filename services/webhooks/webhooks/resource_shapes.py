"""The in-tree providers' resource-identity knowledge.

The mechanism (registry, variant expansion, canonicalisation) is in
`scooter_webhooks_lib.resources`. What lives here is the part that is genuinely
per-provider: how a URL decomposes, and which type spellings mean the same thing.
Only jira is left — the block #582 did not take with it, tracked as #589 — and when
it goes this module goes with it.

Imported for its REGISTRATION side effect — `app.py` imports it at startup. Why: PR #576.
"""

from __future__ import annotations

import re

from scooter_webhooks_lib.resources import (
    ResourceShapes,
    canonical_resource_type,
    register_resource_shapes,
)

_GITHUB_SHORT_RE = re.compile(r"^([^/\s]+)/([^/#\s]+)#(\d+)$")
_GITHUB_URL_RE = re.compile(
    r"^https?://[^/]+/([^/\s]+)/([^/\s]+)/(pull|pulls|issues|issue)/(\d+)(?:[/?#].*)?$"
)
_JIRA_URL_RE = re.compile(r"^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$")


def _jira_id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


register_resource_shapes(
    "jira",
    ResourceShapes(
        type_aliases={"ticket": "issue", "issue": "issue"},
        id_variants=_jira_id_variants,
    ),
)
