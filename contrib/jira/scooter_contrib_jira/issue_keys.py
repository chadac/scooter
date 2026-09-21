"""Jira's issue-key grammar: finding `ENG-42` in free text.

Exported deliberately, because other integrations reference Jira tickets: gitlab
reads keys out of MR titles/branches/descriptions to attach an MR to the
conversation that ticket already opened. That is Jira's grammar, so it lives with
Jira rather than being re-derived by every integration that mentions a ticket.

Pure text handling — no settings, no store, no FastAPI — so importing it costs a
regex, and a contrib that depends on jira for this does not drag a route in with
it. Why: PR #583.
"""

from __future__ import annotations

import re

# PROJECT-123. The project part is upper-case alphanumeric starting with a letter,
# which is what Jira allows.
_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")

# Jira issue numbers start at 1, so a `-0`/`-000` tail is never a ticket. It IS a
# common shape in branch names and versions (RELEASE-0, v2-0), and matching those
# would attach an MR to whatever conversation happened to own a real ticket.
_EXCLUDE_RE = re.compile(r"-0+$")


def extract_issue_keys(*texts: str) -> list[str]:
    """Every Jira key mentioned across `texts`, first mention first, de-duplicated."""
    keys: list[str] = []
    seen: set[str] = set()
    for text in texts:
        for match in _KEY_RE.findall(text or ""):
            if match not in seen and not _EXCLUDE_RE.search(match):
                keys.append(match)
                seen.add(match)
    return keys
