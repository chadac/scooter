"""The in-tree providers' resource-identity knowledge.

The mechanism (registry, variant expansion, canonicalisation) is in
`scooter_webhooks_lib.resources`. What lives here is the part that is genuinely
per-provider: how a github/gitlab/jira URL decomposes, and which type spellings mean
the same thing. Each block travels into its provider's contrib as that provider
migrates (#577+), and when the last one goes this module goes with it.

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


def _github_id_variants(resource_type: str, resource_id: str) -> list[str]:
    """`owner/repo#N` <-> `https://github.com/owner/repo/(pull|issues)/N`."""
    short = _GITHUB_SHORT_RE.match(resource_id)
    if short:
        owner, repo, number = short.groups()
        path = "issues" if canonical_resource_type("github", resource_type) == "issue" else "pull"
        return [resource_id, f"https://github.com/{owner}/{repo}/{path}/{number}"]
    url = _GITHUB_URL_RE.match(resource_id)
    if url:
        owner, repo, _kind, number = url.groups()
        return [resource_id, f"{owner}/{repo}#{number}"]
    return [resource_id]


def _jira_id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


register_resource_shapes(
    "github",
    ResourceShapes(
        type_aliases={"pr": "pull_request", "pull_request": "pull_request", "issue": "issue"},
        id_variants=_github_id_variants,
    ),
)

register_resource_shapes(
    "jira",
    ResourceShapes(
        type_aliases={"ticket": "issue", "issue": "issue"},
        id_variants=_jira_id_variants,
    ),
)

# Slack ids have one spelling (channel+ts), so aliases only — no id_variants.
register_resource_shapes(
    "slack",
    ResourceShapes(type_aliases={"message": "thread", "thread": "thread"}),
)
