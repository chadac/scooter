"""GitLab's resource shapes, registered into `scooter_webhooks_lib.resources`.

`path!iid` (MR) and `path#iid` (issue) <-> the web_url on `settings.gitlab_host`.
"""

from __future__ import annotations

import re

from .config import settings
from scooter_webhooks_lib.resources import (
    ResourceShapes,
    load_type_aliases,
    register_resource_shapes,
)

_GITLAB_SHORT_RE = re.compile(r"^([^\s!#]+/[^\s!#]+)([!#])(\d+)$")
_GITLAB_URL_RE = re.compile(
    r"^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/(\d+)(?:[/?#].*)?$"
)


def _id_variants(_resource_type: str, resource_id: str) -> list[str]:
    short = _GITLAB_SHORT_RE.match(resource_id)
    if short:
        path, sep, iid = short.groups()
        kind = "merge_requests" if sep == "!" else "issues"
        return [resource_id, f"https://{settings.gitlab_host}/{path}/-/{kind}/{iid}"]
    url = _GITLAB_URL_RE.match(resource_id)
    if url:
        path, kind, iid = url.groups()
        sep = "!" if kind == "merge_requests" else "#"
        return [resource_id, f"{path}{sep}{iid}"]
    return [resource_id]


register_resource_shapes(
    "gitlab",
    ResourceShapes(
        type_aliases=load_type_aliases(__package__),
        id_variants=_id_variants,
    ),
)
