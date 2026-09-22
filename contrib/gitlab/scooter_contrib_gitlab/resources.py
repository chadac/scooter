"""GitLab's resource shapes: which ids and type spellings name the same MR/issue.

Registered into `scooter_webhooks_lib.resources` (#576). A web_url also identifies
`path!iid` (MR) / `path#iid` (issue); the reverse is NOT derivable, because the
instance host is not in the short form — so a short id stays itself rather than
becoming a guessed gitlab.com URL. Why: PR #580.
"""

from __future__ import annotations

import re

from scooter_webhooks_lib.resources import ResourceShapes, register_resource_shapes

_GITLAB_URL_RE = re.compile(
    r"^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/(\d+)(?:[/?#].*)?$"
)


def _id_variants(_resource_type: str, resource_id: str) -> list[str]:
    url = _GITLAB_URL_RE.match(resource_id)
    if not url:
        return [resource_id]
    path, kind, iid = url.groups()
    sep = "!" if kind == "merge_requests" else "#"
    return [resource_id, f"{path}{sep}{iid}"]


register_resource_shapes(
    "gitlab",
    ResourceShapes(
        type_aliases={"mr": "merge_request", "merge_request": "merge_request", "issue": "issue"},
        id_variants=_id_variants,
    ),
)
