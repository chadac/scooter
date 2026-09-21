"""Trigger policy — the deployment-wide rules every handler applies identically.

What spawns a conversation (a mention, a label), whose events to drop (ignored
users, bots, our own chatter). These are ONE deployment's policy, not a provider's:
a mention pattern that differed between github and slack would be a bug, so this is
lib surface rather than something each contrib owns.

Each of these was copy-pasted into all four handlers -- `_is_ignored_user` was
byte-identical four times, and re-parsed the comma-separated list on every event.
A contrib handler couldn't reach any of it without importing the app. Why: PR #577.

CONFIG STAYS IN THE APP: like `store.DatabaseConfig` and `agent_host_client`, this
module is GIVEN its settings at startup.
"""

from __future__ import annotations

from typing import Protocol


class TriggerPolicyConfig(Protocol):
    """What the policy needs from whatever settings object the app hands it."""

    mention_pattern: str
    label_trigger: str
    ignore_usernames: str
    ignore_bot_authors: bool

    def get_repo_descriptions(self) -> dict[str, str]: ...


_config: TriggerPolicyConfig | None = None

# Parsed per distinct VALUE, not per event and not once per process: the four copies
# this replaces re-split the string on every delivery, but snapshotting it at init()
# would silently ignore a settings change at runtime -- which the self-event tests
# make (patch.object(settings, "ignore_usernames", ...)) and a live reload could too.
_ignored_cache: tuple[str, frozenset[str]] = ("", frozenset())


def init(config: TriggerPolicyConfig) -> None:
    """Bind the trigger policy. Called once at service startup."""
    global _config
    _config = config


def _cfg() -> TriggerPolicyConfig:
    if _config is None:
        raise RuntimeError("scooter_webhooks_lib.policy.init(config) was never called")
    return _config


def mentions_agent(text: str) -> bool:
    """Does this text mention the agent (case-insensitive)?"""
    return _cfg().mention_pattern.lower() in (text or "").lower()


def mention_pattern() -> str:
    """The raw trigger text, for handlers that rewrite it rather than test it
    (slack substitutes `<@BOT>` with it before forwarding)."""
    return _cfg().mention_pattern


def strip_mention(text: str) -> str:
    """The message with the mention removed — what actually gets forwarded."""
    return (text or "").replace(_cfg().mention_pattern, "").strip()


def is_trigger_label(label: str) -> bool:
    """Is this the label whose addition spawns a conversation?"""
    return (label or "").lower() == _cfg().label_trigger.lower()


def is_ignored_user(username: str) -> bool:
    """Is this author on the deployment's drop list? (case-insensitive)"""
    global _ignored_cache
    raw = _cfg().ignore_usernames or ""
    if _ignored_cache[0] != raw:
        _ignored_cache = (raw, frozenset(u.strip().lower() for u in raw.split(",") if u.strip()))
    return bool(username) and username.lower() in _ignored_cache[1]


def ignore_bot_authors() -> bool:
    """Drop Bot-authored events that don't mention the agent.

    The fallback for when the agent's own `<slug>[bot]` login can't be resolved:
    its own comments otherwise come back as webhooks, at interrupt priority for
    reviews (PR #530).
    """
    return _cfg().ignore_bot_authors


def repo_description(repo: str) -> str | None:
    """The configured description for a repo, if any."""
    return _cfg().get_repo_descriptions().get(repo) or None


def repo_context(repo: str) -> str:
    """The repo description as a prompt fragment, or empty."""
    desc = repo_description(repo)
    return f"\nRepo description: {desc}\n" if desc else ""


def is_own_ack(body: str) -> bool:
    """Is this comment one of ours?

    Matches the ack text handlers post. Keeps matching the legacy "OpenHands"
    markers so threads created before the rename still match.
    """
    return (
        body.startswith("Scooter is on it")
        or body.startswith("OpenHands is working on this.")
        or "OpenHands status:" in body
    )
