"""Canonical shapes for (source, resource_type, resource_id) — the ONE place that
knows ("pull_request", "o/r#7") and ("pr", "<html_url>") are the same resource.

Nothing here rewrites conversation_map: its resource_id is matched EXACTLY to route an
incoming webhook, so we normalise what we WRITE to resource_links and match every known
shape on READ. Why: PR #571.
"""

from __future__ import annotations

import re

# The canonical (long) resource_type per source. Long form because it is what
# conversation_map already holds and what the UI renders ("pull request", not "pr").
_TYPE_ALIASES: dict[str, dict[str, str]] = {
    "github": {"pr": "pull_request", "pull_request": "pull_request", "issue": "issue"},
    "gitlab": {"mr": "merge_request", "merge_request": "merge_request", "issue": "issue"},
    "jira": {"ticket": "issue", "issue": "issue"},
    "slack": {"message": "thread", "thread": "thread"},
}

_GITHUB_SHORT_RE = re.compile(r"^([^/\s]+)/([^/#\s]+)#(\d+)$")
_GITHUB_URL_RE = re.compile(
    r"^https?://[^/]+/([^/\s]+)/([^/\s]+)/(pull|pulls|issues|issue)/(\d+)(?:[/?#].*)?$"
)
_GITLAB_URL_RE = re.compile(
    r"^https?://[^/]+/(.+?)/(?:-/)?(merge_requests|issues)/(\d+)(?:[/?#].*)?$"
)
_JIRA_URL_RE = re.compile(r"^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$")


def canonical_resource_type(source: str, resource_type: str) -> str:
    """The long-form type for this source; unknown types pass through unchanged."""
    return _TYPE_ALIASES.get(source, {}).get(resource_type.lower(), resource_type)


def _type_variants(source: str, resource_type: str) -> list[str]:
    """Every spelling of this type, the caller's own first."""
    canonical = canonical_resource_type(source, resource_type)
    others = [
        alias
        for alias, target in _TYPE_ALIASES.get(source, {}).items()
        if target == canonical and alias != resource_type
    ]
    return [resource_type, *others]


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


def _gitlab_id_variants(resource_id: str) -> list[str]:
    """A web_url also identifies `path!iid` (MR) / `path#iid` (issue). The reverse
    is not derivable — the instance host is not in the short form."""
    url = _GITLAB_URL_RE.match(resource_id)
    if not url:
        return [resource_id]
    path, kind, iid = url.groups()
    sep = "!" if kind == "merge_requests" else "#"
    return [resource_id, f"{path}{sep}{iid}"]


def _jira_id_variants(resource_id: str) -> list[str]:
    url = _JIRA_URL_RE.match(resource_id)
    return [resource_id, url.group(1).upper()] if url else [resource_id]


def resource_id_variants(source: str, resource_type: str, resource_id: str) -> list[str]:
    """Every id form that names this resource, the caller's own first. An id that
    parses as nothing known yields only itself — no invented URL, so an unlinked
    resource still resolves to nothing rather than to someone else's."""
    if source == "github":
        return _github_id_variants(resource_type, resource_id)
    if source == "gitlab":
        return _gitlab_id_variants(resource_id)
    if source == "jira":
        return _jira_id_variants(resource_id)
    return [resource_id]


def link_variants(source: str, resource_type: str, resource_id: str) -> list[tuple[str, str]]:
    """(resource_type, resource_id) pairs to try, the caller's own shape FIRST so a
    row written in this service's terms still matches without a rewrite."""
    out: list[tuple[str, str]] = []
    for rid in resource_id_variants(source, resource_type, resource_id):
        for rtype in _type_variants(source, resource_type):
            pair = (rtype, rid)
            if pair not in out:
                out.append(pair)
    return out


def canonical_link(source: str, resource_type: str, resource_id: str) -> tuple[str, str]:
    """The shape to STORE in resource_links: long-form type, and the URL form when
    one is derivable (what the agent-host writes, and so what the table already
    mostly holds)."""
    rtype = canonical_resource_type(source, resource_type)
    rid = resource_id
    for candidate in resource_id_variants(source, rtype, resource_id):
        if candidate.startswith("http://") or candidate.startswith("https://"):
            rid = candidate
            break
    return rtype, rid
