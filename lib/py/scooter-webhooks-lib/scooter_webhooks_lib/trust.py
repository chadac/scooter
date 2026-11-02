"""Who may steer the agent by forge comment, and holding the rest."""

from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import text

from scooter_lib.logging_config import format_error, pseudonym

from . import store
from .agent_host_client import Screen, screen_message

logger = logging.getLogger(__name__)
_C = {"component": "trust"}

# Posted once where an outsider's mention starts nothing.
DECLINE_REPLY = "A maintainer needs to ask Scooter to pick this up."

# Which Scooter user linked which forge login.
_LINK_TABLES = {"github": "github_user_tokens", "gitlab": "gitlab_user_tokens"}


@dataclass(frozen=True)
class Author:
    source: str
    login: str
    # Repo standing, the allowlist, or a linked Scooter account.
    standing: bool
    # Linked Scooter users; a private conversation trusts its owner.
    user_ids: tuple[str, ...] = ()


def _logins(raw: str) -> frozenset[str]:
    return frozenset(u.strip().lower() for u in (raw or "").split(",") if u.strip())


async def linked_users(source: str, login: str) -> list[str]:
    """Scooter users who linked this login; empty when unknowable."""
    table = _LINK_TABLES.get(source)
    db_name = os.environ.get(f"CONTRIB_{source.upper()}_DB_NAME")
    if not table or not db_name or not login:
        return []
    engine = store.engine_for(db_name)
    if engine is None:
        return []
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(
                text(f"SELECT user_id FROM {table} WHERE lower(login) = lower(:login)"), {"login": login},
            )
            return [r[0] for r in rows]
    except Exception as e:
        # Unknown means untrusted, costing only an approval card.
        logger.warning(
            "linked-account lookup failed",
            extra={**_C, "source": source, "author": pseudonym(login), "error": format_error(e)},
        )
        return []


async def classify(source: str, login: str, *, repo_standing: bool, trusted_users: str) -> Author:
    """The author's standing, ignoring any one conversation's rules."""
    user_ids = tuple(await linked_users(source, login))
    standing = repo_standing or login.lower() in _logins(trusted_users) or bool(user_ids)
    return Author(source=source, login=login, standing=standing, user_ids=user_ids)


def card_prompt(author: Author, where: str, body: str) -> str:
    """The card text: who wrote what, in full, where."""
    return f"@{author.login} commented on {where}. The agent sees it only if you allow it.\n\n{body}"


async def screen(
    conversation_id: str,
    author: Author,
    *,
    message: str,
    prompt: str,
    url: str,
    require_approval: bool,
) -> Screen:
    """DELIVER means send it now; anything else means don't."""
    if not require_approval:
        return Screen.DELIVER
    return await screen_message(
        conversation_id,
        source=author.source,
        author=author.login,
        standing=author.standing,
        author_user_ids=list(author.user_ids),
        text=message,
        prompt=prompt,
        url=url,
    )


async def decline_mention(
    author: Author, resource_type: str, resource_id: str, repo: str, post: Callable[[str], Awaitable[object]],
) -> None:
    """Start nothing; reply on the resource the first time only."""
    logger.info(
        "declined an outsider's mention",
        extra={
            **_C,
            "source": author.source,
            "repo": repo,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "author": pseudonym(author.login),
        },
    )
    if await store.claim_outsider_reply(author.source, resource_type, resource_id):
        await post(DECLINE_REPLY)
