"""GitLab webhook handler.

A mention in a comment creates or forwards a conversation, the trigger label on an
issue or MR creates one, and any comment on a resource with an active conversation
is auto-forwarded.
"""

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending

from .config import settings
from scooter_webhooks_lib.agent_host_client import (
    SendOutcome, conversation_url, create_conversation, deliver_message, push_link, send_message,
)
from scooter_contrib_jira.issue_keys import extract_issue_keys
from scooter_webhooks_lib import policy
from scooter_webhooks_lib.identity import resolve_owner
from scooter_webhooks_lib.reply_workflow import reply_workflow
from scooter_webhooks_lib.sender import Sender
from scooter_webhooks_lib.tasks import spawn
from .responses import get_own_username, post_gitlab_comment
from .senders import sender_of

logger = logging.getLogger(__name__)
_C = {"component": "handlers.gitlab"}
router = APIRouter()

def _verify_signature(body: bytes, token: str) -> bool:
    # Fail closed: an unset secret must not admit forged events.
    if not settings.gitlab_webhook_secret:
        logger.warning("GITLAB_WEBHOOK_SECRET is not set; rejecting the unverifiable delivery", extra=_C)
        return False
    return hmac.compare_digest(token, settings.gitlab_webhook_secret)


def _extract_repo(payload: dict) -> str:
    return payload.get("project", {}).get("path_with_namespace", settings.default_gitlab_repo)


def _resource_id(repo: str, resource_type: str, iid: int) -> str:
    sep = "!" if resource_type == "merge_request" else "#"
    return f"{repo}{sep}{iid}"


async def _infer_conversation_from_jira(
    jira_keys: list[str], gitlab_resource_type: str, gitlab_resource_id: str,
) -> str | None:
    for key in jira_keys:
        conv_id = (
            await db.lookup_conversation("jira", "issue", key)
            or await db.get_conversation_for_resource("jira", "issue", key)
        )
        if conv_id:
            await db.link_resource(conv_id, "gitlab", gitlab_resource_type, gitlab_resource_id)
            logger.info(
                "auto-linked gitlab resource to conversation via jira",
                extra={
                    **_C,
                    "conversation_id": conv_id,
                    "source": "gitlab",
                    "resource_type": gitlab_resource_type,
                    "resource_id": gitlab_resource_id,
                    "jira_key": key,
                },
            )
            return conv_id
    return None


def _reply_steps(note_id: int | None) -> str:
    return reply_workflow("gitlab_comment", "agent-tools", react=bool(note_id))


def _note_ref(note_id: int | None) -> str:
    """The id of this note, so a reply or reaction can target it."""
    return f"\n\n(note_id: {note_id})" if note_id else ""


def _response_instructions(noteable_type: str, noteable_iid: int, note_id: int | None = None) -> str:
    kind = "merge request" if noteable_type == "merge_requests" else "issue"
    return (
        f"\n\n---\n"
        f"{_reply_steps(note_id)}\n\n"
        f"To respond on GitLab {kind} {noteable_iid}, use the `gitlab_comment` tool with your comment `body` — "
        f"the target is already known."
        + _note_ref(note_id)
    )


def _format_diff_context(note: dict) -> str:
    if note.get("type") != "DiffNote":
        return ""
    position = note.get("position", {})
    file_path = position.get("new_path") or position.get("old_path", "")
    if not file_path:
        return ""
    new_line = position.get("new_line")
    old_line = position.get("old_line")
    if new_line:
        return f"**Review comment on `{file_path}` line {new_line}:**"
    elif old_line:
        return f"**Review comment on `{file_path}` (removed line {old_line}):**"
    return f"**Review comment on `{file_path}`:**"


def _format_forwarded_message(
    comment_body: str, project_id: int, noteable_type: str, noteable_iid: int,
    discussion_id: str | None = None, has_mention: bool = False, note_id: int | None = None,
) -> str:
    iid_prefix = "!" if noteable_type == "merge_requests" else "#"

    if discussion_id:
        reply_instruction = (
            "To respond, use the `gitlab_comment` tool (this MR is already known — you "
            f"just provide the body). Pass `discussion_id=\"{discussion_id}\"` to reply "
            "within this review thread; omit it for a top-level comment. It reports the "
            "real result."
        )
    else:
        reply_instruction = (
            "To respond, use the `gitlab_comment` tool (this MR is already known — you "
            "just provide the body). It reports the real result."
        )

    if has_mention:
        preamble = (
            f"You were mentioned in a comment on GitLab {noteable_type.replace('_', ' ')} {iid_prefix}{noteable_iid}."
        )
    else:
        preamble = (
            f"A new comment was posted on GitLab {noteable_type.replace('_', ' ')} {iid_prefix}{noteable_iid}. "
            f"Respond only if it is addressed to you or asks for something."
        )

    return (
        f"{preamble}\n\n---\n\n{comment_body}\n\n---\n\n{_reply_steps(note_id)}\n\n{reply_instruction}"
        + _note_ref(note_id)
    )


@router.post("/webhooks/gitlab")
async def handle_gitlab_webhook(
    request: Request,
    x_gitlab_event: str = Header(...),
    x_gitlab_token: str = Header(""),
):
    if not settings.gitlab_enabled:
        return {"status": "disabled"}

    body = await request.body()
    if not _verify_signature(body, x_gitlab_token):
        raise HTTPException(status_code=401, detail="Invalid webhook token")

    payload = await request.json()
    event_type = x_gitlab_event

    logger.info("received event", extra={**_C, "source": "gitlab", "event_type": event_type})
    spawn(_dispatch(event_type, payload), extra={"source": "gitlab", "event_type": event_type})
    return {"status": "ok"}


async def _dispatch(event_type: str, payload: dict) -> None:
    if event_type == "Note Hook":
        await _handle_note(payload)
    elif event_type == "Issue Hook":
        await _handle_issue(payload)
    elif event_type == "Merge Request Hook":
        await _handle_merge_request(payload)
    else:
        logger.debug("ignoring event type", extra={**_C, "source": "gitlab", "event_type": event_type})


async def _handle_note(payload: dict):
    note = payload.get("object_attributes", {})
    note_body = note.get("note", "")
    user = payload.get("user", {}).get("username", "unknown")
    repo = _extract_repo(payload)
    noteable_type = note.get("noteable_type", "")

    if policy.is_ignored_user(user):
        return
    if policy.is_own_ack(note_body):
        return
    # A mention still counts: the token may be a person's own PAT.
    own = await get_own_username()
    if own and user.lower() == own.lower() and not policy.mentions_agent(note_body):
        return

    # Branch-specific fields, bound up front so the noteable_type-gated blocks below are never "possibly unbound".
    mr: dict = {}
    issue: dict = {}
    mr_title = source_branch = ""
    issue_title = ""
    mr_iid: int | None = None
    issue_iid: int | None = None

    if noteable_type == "MergeRequest":
        mr = payload.get("merge_request", {})
        mr_title = mr.get("title", "")
        mr_iid = mr.get("iid")
        source_branch = mr.get("source_branch", "")
        project_id = payload.get("project", {}).get("id")
        noteable_iid = mr_iid
        note_api_type = "merge_requests"
        res_type = "merge_request"
        res_id = _resource_id(repo, res_type, mr_iid)
        web_url = mr.get("url")
        context = f"Context: MR !{mr_iid} '{mr_title}' (branch: {source_branch}) in {repo}"
    elif noteable_type == "Issue":
        issue = payload.get("issue", {})
        issue_title = issue.get("title", "")
        issue_iid = issue.get("iid")
        project_id = payload.get("project", {}).get("id")
        noteable_iid = issue_iid
        note_api_type = "issues"
        res_type = "issue"
        res_id = _resource_id(repo, res_type, issue_iid)
        web_url = issue.get("url")
        context = f"Context: Issue #{issue_iid} '{issue_title}' in {repo}"
    else:
        return

    has_mention = policy.mentions_agent(note_body)
    existing = (
        await db.lookup_conversation("gitlab", res_type, res_id)
        or await db.get_conversation_for_resource("gitlab", res_type, res_id)
        # A link stored under a URL the configured host can't rebuild.
        or (web_url and await db.get_conversation_for_resource("gitlab", res_type, web_url))
    )

    if not existing and noteable_type == "MergeRequest":
        mr_desc = mr.get("description", "")
        jira_keys = extract_issue_keys(mr_title, source_branch, mr_desc)
        if jira_keys:
            existing = await _infer_conversation_from_jira(jira_keys, res_type, res_id)
    elif not existing and noteable_type == "Issue":
        issue_desc = issue.get("description", "")
        jira_keys = extract_issue_keys(issue_title, issue_desc)
        if jira_keys:
            existing = await _infer_conversation_from_jira(jira_keys, res_type, res_id)

    if not has_mention and not existing:
        logger.info(
            "note on unlinked resource without mention; ignoring",
            extra={**_C, "source": "gitlab", "resource_type": res_type, "resource_id": res_id},
        )
        return
    sender = await sender_of(payload)

    message_text = policy.strip_mention(note_body)
    diff_context = _format_diff_context(note)
    comment_body = f"{diff_context}\n\n@{user} commented:\n\n{message_text}" if diff_context else f"@{user} commented:\n\n{message_text}"

    if is_pending(existing):
        discussion_id = note.get("discussion_id")
        forward_msg = _format_forwarded_message(
            comment_body, project_id, note_api_type, noteable_iid,
            discussion_id=discussion_id, has_mention=has_mention, note_id=note.get("id"),
        )
        await db.store_pending_message("gitlab", res_type, res_id, forward_msg, sender)
        return

    if existing:
        discussion_id = note.get("discussion_id")
        forward_msg = _format_forwarded_message(
            comment_body, project_id, note_api_type, noteable_iid,
            discussion_id=discussion_id, has_mention=has_mention, note_id=note.get("id"),
        )
        outcome = await deliver_message(existing, forward_msg, source="gitlab", sender=sender)
        logger.info(
            "forwarded note to conversation",
            extra={
                **_C,
                "conversation_id": existing,
                "outcome": outcome.value,
                "source": "gitlab",
                "resource_type": res_type,
                "resource_id": res_id,
            },
        )
        if outcome is not SendOutcome.NOT_FOUND:
            # The conversation still exists, so a failed run keeps its mapping (issue #802).
            if outcome is not SendOutcome.DELIVERED:
                logger.warning(
                    "forward to existing conversation failed, keeping it",
                    extra={
                        **_C,
                        "conversation_id": existing,
                        "outcome": outcome.value,
                        "source": "gitlab",
                        "resource_type": res_type,
                        "resource_id": res_id,
                    },
                )
            return
        logger.warning(
            "existing conversation no longer exists, creating a new one",
            extra={
                **_C,
                "conversation_id": existing,
                "source": "gitlab",
                "resource_type": res_type,
                "resource_id": res_id,
            },
        )

    await db.store_conversation("gitlab", res_type, res_id, PENDING_CONVERSATION_ID)

    if noteable_type == "MergeRequest":
        conv_title = f"MR !{mr_iid}: {mr_title}"
    else:
        conv_title = f"Issue #{issue_iid}: {issue_title}"

    reply_hint = _response_instructions(note_api_type, noteable_iid, note.get("id"))
    full_message = f"{context}\n{policy.repo_context(repo)}\n{comment_body}{reply_hint}"

    spawn(
        _background_create_conversation(
            source="gitlab", res_type=res_type, res_id=res_id,
            message=full_message, repo=repo, conv_title=conv_title,
            project_id=project_id, note_api_type=note_api_type,
            noteable_iid=noteable_iid, invoking_user=user, sender=sender,
        )
    )


async def _handle_issue(payload: dict):
    action = payload.get("object_attributes", {}).get("action", "")
    labels = [l.get("title", "").lower() for l in payload.get("labels", [])]
    if action != "update" or not any(policy.is_trigger_label(l) for l in labels):
        return

    issue = payload.get("object_attributes", {})
    repo = _extract_repo(payload)
    issue_title = issue.get("title", "")
    issue_desc = issue.get("description", "")
    issue_iid = issue.get("iid")
    project_id = payload.get("project", {}).get("id")
    res_id = _resource_id(repo, "issue", issue_iid)

    jira_keys = extract_issue_keys(issue_title, issue_desc)
    if jira_keys:
        await _infer_conversation_from_jira(jira_keys, "issue", res_id)

    await db.store_conversation("gitlab", "issue", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions("issues", issue_iid)
    message = f"Issue #{issue_iid} '{issue_title}' in {repo}\n\n{issue_desc}{reply_hint}"

    spawn(
        _background_create_conversation(
            source="gitlab", res_type="issue", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"Issue #{issue_iid}: {issue_title}",
            project_id=project_id, note_api_type="issues",
            invoking_user=payload.get("user", {}).get("username"),
            noteable_iid=issue_iid, event=payload,
        )
    )


async def _handle_merge_request(payload: dict):
    action = payload.get("object_attributes", {}).get("action", "")
    labels = [l.get("title", "").lower() for l in payload.get("labels", [])]
    if action != "update" or not any(policy.is_trigger_label(l) for l in labels):
        return

    mr = payload.get("object_attributes", {})
    repo = _extract_repo(payload)
    mr_title = mr.get("title", "")
    mr_desc = mr.get("description", "")
    mr_iid = mr.get("iid")
    source_branch = mr.get("source_branch", "")
    project_id = payload.get("project", {}).get("id")
    res_id = _resource_id(repo, "merge_request", mr_iid)

    jira_keys = extract_issue_keys(mr_title, source_branch, mr_desc)
    if jira_keys:
        await _infer_conversation_from_jira(jira_keys, "merge_request", res_id)

    await db.store_conversation("gitlab", "merge_request", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions("merge_requests", mr_iid)
    message = f"MR !{mr_iid} '{mr_title}' (branch: {source_branch}) in {repo}\n\n{mr_desc}{reply_hint}"

    spawn(
        _background_create_conversation(
            source="gitlab", res_type="merge_request", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"MR !{mr_iid}: {mr_title}",
            project_id=project_id, note_api_type="merge_requests",
            invoking_user=payload.get("user", {}).get("username"),
            noteable_iid=mr_iid, event=payload,
        )
    )


async def _background_create_conversation(
    source: str, res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, project_id: int, note_api_type: str,
    noteable_iid: int, invoking_user: str | None = None,
    sender: Sender | None = None, event: dict | None = None,
) -> None:
    """Start a conversation for a resource; `event` names the sender when `sender` isn't given."""
    # Runs pre-run, since create_conversation blocks until the whole agent turn finishes.
    async def _register(conv_id: str) -> None:
        await db.store_conversation(source, res_type, res_id, conv_id)
        # gitlab_comment reads `mrIid` as "this is merge request N", so an issue's iid goes in `iid`.
        iid_key = "mrIid" if res_type == "merge_request" else "iid"
        await push_link(
            conv_id, source="gitlab", resource_type=res_type,
            title=res_id,
            ref={"projectId": str(project_id), iid_key: str(noteable_iid)},
        )
        await post_gitlab_comment(
            project_id=project_id, noteable_type=note_api_type,
            noteable_iid=noteable_iid,
            body=f"Scooter is on it — follow along: [View conversation]({conversation_url(conv_id)})",
        )

    # Best-effort owner lookup; None leaves the conversation unowned.
    conv_owner = await resolve_owner("gitlab", invoking_user) if invoking_user else None
    if sender is None and event is not None:
        # Looked up here, off the webhook's response path.
        sender = await sender_of(event)

    try:
        result = await create_conversation(
            message, repository=repo, title=conv_title, on_created=_register,
            owner=conv_owner, source="gitlab", sender=sender,
        )
        if not result:
            await _clear_pending(source, res_type, res_id)
            # Correct the optimistic comment already posted in _register.
            await post_gitlab_comment(
                project_id=project_id, noteable_type=note_api_type,
                noteable_iid=noteable_iid,
                body="…actually, Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        if result.get("interrupted"):
            # The agent-host resumes the interrupted run on boot, so neither post a failure nor flush pending.
            return

        if result.get("errored"):
            # The conversation exists and did work, so this is an error partway through, not a failed start.
            await _clear_pending(source, res_type, res_id)
            conv_id = result.get("conversation_id", "")
            await post_gitlab_comment(
                project_id=project_id, noteable_type=note_api_type,
                noteable_iid=noteable_iid,
                body=f"Scooter hit an error partway through — see the [conversation]({conversation_url(conv_id)}) for details.",
            )
            return

        conv_id = result.get("conversation_id", "")

        messages = await db.get_and_clear_pending_messages(source, res_type, res_id)
        for msg, msg_sender in messages:
            ok = await send_message(conv_id, msg, source="gitlab", sender=msg_sender)
            if not ok:
                logger.warning(
                    "flush of pending message failed",
                    extra={**_C, "conversation_id": conv_id, "source": source, "resource_id": res_id},
                )
    except Exception:
        await _clear_pending(source, res_type, res_id)
        logger.exception(
            "background conversation creation failed",
            extra={**_C, "source": source, "resource_type": res_type, "resource_id": res_id},
        )


async def _clear_pending(source: str, res_type: str, res_id: str) -> None:
    existing = await db.lookup_conversation(source, res_type, res_id)
    if is_pending(existing):
        await db.clear_conversation(source, res_type, res_id)
    await db.get_and_clear_pending_messages(source, res_type, res_id)


# Discovered and mounted by the webhooks service via the entry-point registry; the handler self-gates in-route.
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

# Imported for their registration side effects.
from . import identity  # noqa: F401
from . import resources  # noqa: F401


@register_webhook
def gitlab() -> WebhookHandler:
    return WebhookHandler(name="gitlab", router=router)
