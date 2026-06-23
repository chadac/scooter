"""Status polling daemon — monitors conversation status and updates source comments.

Polls the OpenHands API for status changes and updates the corresponding
comment on GitHub/GitLab/Jira/Slack. Reloads active conversations from
the database on startup.

The lifecycle concerns (idle cleanup, orphan cleanup) have been moved to
the lifecycle service.
"""

import asyncio
import logging
from dataclasses import dataclass

from . import store as db

from .config import settings
from .agent_host_client import conversation_url, get_conversation_statuses
from .responses.github import update_github_comment
from .responses.gitlab import update_gitlab_comment
from .responses.jira import update_jira_comment
from .responses.slack import update_slack_message

logger = logging.getLogger(__name__)

DISPLAY_STATUS = {
    "RUNNING": "RUNNING",
    "AWAITING_USER_INPUT": "AWAITING USER INPUT",
    "FINISHED": "READY",
    "CLOSED": "FINISHED",
    "STOPPED": "FINISHED",
    "ERROR": "ERRORED",
}

STATUS_EMOJI = {
    "RUNNING": "hourglass_flowing_sand",
    "AWAITING_USER_INPUT": "raising_hand",
    "FINISHED": "white_check_mark",
    "CLOSED": "lock",
    "STOPPED": "stop_sign",
    "ERROR": "x",
}

POLL_INTERVAL = 20.0

_TERMINAL_STATUSES = {"CLOSED", "STOPPED", "ERROR", "FINISHED"}


@dataclass
class TrackedConversation:
    conversation_id: str
    source: str
    resource_id: str
    project_id: int | None = None
    noteable_type: str | None = None
    noteable_iid: int | None = None
    note_id: int | str | None = None
    github_owner: str | None = None
    github_repo: str | None = None
    github_issue_number: int | None = None
    slack_channel: str | None = None
    slack_ts: str | None = None
    last_status: str | None = None


_tracked: dict[str, TrackedConversation] = {}
_task: asyncio.Task | None = None


def track(
    conversation_id: str, project_id: int, noteable_type: str,
    noteable_iid: int, note_id: int,
) -> None:
    """Register a GitLab conversation for status monitoring."""
    _tracked[conversation_id] = TrackedConversation(
        conversation_id=conversation_id, source="gitlab", resource_id="",
        project_id=project_id, noteable_type=noteable_type,
        noteable_iid=noteable_iid, note_id=note_id,
    )
    asyncio.create_task(
        db.store_note_metadata(conversation_id, project_id, noteable_type, noteable_iid, note_id)
    )
    logger.info("Tracking conversation %s (gitlab note %s)", conversation_id, note_id)


def track_jira(conversation_id: str, issue_key: str, comment_id: str) -> None:
    """Register a Jira conversation for status monitoring."""
    _tracked[conversation_id] = TrackedConversation(
        conversation_id=conversation_id, source="jira",
        resource_id=issue_key, note_id=comment_id,
    )
    asyncio.create_task(db.store_jira_comment_id(conversation_id, comment_id))
    logger.info("Tracking conversation %s (jira comment %s on %s)", conversation_id, comment_id, issue_key)


def track_slack(conversation_id: str, channel: str, message_ts: str) -> None:
    """Register a Slack conversation for status monitoring."""
    _tracked[conversation_id] = TrackedConversation(
        conversation_id=conversation_id, source="slack",
        resource_id=f"{channel}:{message_ts}",
        slack_channel=channel, slack_ts=message_ts,
    )
    asyncio.create_task(db.store_slack_metadata(conversation_id, channel, message_ts))
    logger.info("Tracking conversation %s (slack %s in %s)", conversation_id, message_ts, channel)


def track_github(
    conversation_id: str, owner: str, repo: str,
    issue_number: int, comment_id: int,
) -> None:
    """Register a GitHub conversation for status monitoring."""
    resource_id = f"{owner}/{repo}#{issue_number}"
    _tracked[conversation_id] = TrackedConversation(
        conversation_id=conversation_id, source="github",
        resource_id=resource_id, note_id=comment_id,
        github_owner=owner, github_repo=repo,
        github_issue_number=issue_number,
    )
    asyncio.create_task(
        db.store_note_metadata(conversation_id, 0, "github", issue_number, comment_id)
    )
    logger.info("Tracking conversation %s (github comment %s on %s)", conversation_id, comment_id, resource_id)


def _format_comment(conv_id: str, status: str) -> str:
    emoji = STATUS_EMOJI.get(status, "question")
    label = DISPLAY_STATUS.get(status, status)
    link = conversation_url(conv_id)
    return f":{emoji}: OpenHands status: **{label}**\n\n[View conversation]({link})"


def _format_slack_message(conv_id: str, status: str) -> str:
    emoji = STATUS_EMOJI.get(status, "question")
    label = DISPLAY_STATUS.get(status, status)
    link = conversation_url(conv_id)
    return f":{emoji}: *OpenHands status: {label}*\n\n<{link}|View conversation>"


def _format_jira_comment(conv_id: str, status: str) -> str:
    link = conversation_url(conv_id)
    emoji = STATUS_EMOJI.get(status, "question")
    emoji_map = {
        "hourglass_flowing_sand": "(i)", "raising_hand": "(!)",
        "white_check_mark": "(/)", "lock": "(/)",
        "stop_sign": "(x)", "x": "(x)", "question": "(?)",
    }
    icon = emoji_map.get(emoji, "")
    label = DISPLAY_STATUS.get(status, status)
    return f"{icon} OpenHands status: {label}\n\nView conversation: {link}"


async def _load_from_db() -> None:
    """Reload active conversations from DB after restart."""
    try:
        rows = await db.get_active_conversations()
    except Exception:
        logger.warning("status_monitor: store not ready; skipping reload", exc_info=True)
        return
    for row in rows:
        conv_id = row["conversation_id"]
        last_status = row.get("last_status")
        if last_status in _TERMINAL_STATUSES:
            continue
        if conv_id not in _tracked:
            source = row.get("source", "gitlab")
            tc = TrackedConversation(
                conversation_id=conv_id, source=source,
                resource_id=row.get("resource_id", ""),
                project_id=row.get("project_id"),
                noteable_type=row.get("noteable_type"),
                noteable_iid=row.get("noteable_iid"),
                note_id=row.get("note_id"),
                slack_channel=row.get("slack_channel"),
                slack_ts=row.get("slack_ts"),
                last_status=last_status,
            )
            if source == "github" and tc.resource_id:
                parts = tc.resource_id.rsplit("#", 1)
                if len(parts) == 2:
                    repo_part = parts[0]
                    slash_idx = repo_part.find("/")
                    if slash_idx > 0:
                        tc.github_owner = repo_part[:slash_idx]
                        tc.github_repo = repo_part[slash_idx + 1:]
                        try:
                            tc.github_issue_number = int(parts[1])
                        except ValueError:
                            pass
            _tracked[conv_id] = tc
    if _tracked:
        logger.info("Loaded %d active conversations from DB", len(_tracked))


async def _poll_once() -> None:
    """Check all tracked conversations and update their source comments."""
    conv_ids = list(_tracked.keys())
    if not conv_ids:
        return

    statuses = await get_conversation_statuses(conv_ids)

    for conv_id, tc in list(_tracked.items()):
        try:
            status = statuses.get(conv_id)
            if status is None:
                continue

            if status != tc.last_status:
                tc.last_status = status
                await db.update_last_status(conv_id, status)

                if tc.source == "github" and tc.github_owner and tc.note_id:
                    body = _format_comment(conv_id, status)
                    await update_github_comment(
                        owner=tc.github_owner, repo=tc.github_repo,
                        comment_id=int(tc.note_id), body=body,
                    )
                elif tc.source == "jira" and tc.resource_id and tc.note_id:
                    body = _format_jira_comment(conv_id, status)
                    await update_jira_comment(
                        issue_key=tc.resource_id, comment_id=str(tc.note_id), body=body,
                    )
                elif tc.source == "gitlab" and tc.project_id and tc.note_id:
                    body = _format_comment(conv_id, status)
                    await update_gitlab_comment(
                        project_id=tc.project_id, noteable_type=tc.noteable_type,
                        noteable_iid=tc.noteable_iid, note_id=tc.note_id, body=body,
                    )
                elif tc.source == "slack" and tc.slack_channel and tc.slack_ts:
                    body = _format_slack_message(conv_id, status)
                    await update_slack_message(
                        channel=tc.slack_channel, ts=tc.slack_ts, text=body,
                    )

            if status in _TERMINAL_STATUSES:
                del _tracked[conv_id]
                logger.info("Stopped tracking %s (terminal: %s)", conv_id, status)
        except Exception:
            logger.exception("Error polling conversation %s", conv_id)


async def _run_loop() -> None:
    """Main monitor loop."""
    logger.info("Status monitor started (interval=%ss)", POLL_INTERVAL)
    await _load_from_db()
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        if _tracked:
            await _poll_once()


def start() -> None:
    """Start the background monitor task (idempotent)."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_run_loop())


def stop() -> None:
    """Stop the background monitor task."""
    global _task
    if _task and not _task.done():
        _task.cancel()
        _task = None
