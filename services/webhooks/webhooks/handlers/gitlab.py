"""GitLab webhook handler.

Trigger rules:
- @openhands mention in a comment -> creates/forwards conversation
- 'openhands' label added to issue/MR -> creates conversation
- Any comment on resource with active conversation -> auto-forwarded
"""

import asyncio
import hmac
import logging
import re

from fastapi import APIRouter, Header, HTTPException, Request

from .. import store as db
from ..store import PENDING_CONVERSATION_ID, is_pending

from ..config import settings
from ..agent_host_client import conversation_url, create_conversation, push_link, send_message
from ..responses.gitlab import post_gitlab_comment

logger = logging.getLogger(__name__)
router = APIRouter()

_JIRA_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")
_JIRA_KEY_EXCLUDE_RE = re.compile(r"-0+$")


def _verify_signature(body: bytes, token: str) -> bool:
    if not settings.gitlab_webhook_secret:
        return True
    return hmac.compare_digest(token, settings.gitlab_webhook_secret)


def _contains_mention(text: str) -> bool:
    return settings.mention_pattern.lower() in text.lower()


def _extract_repo(payload: dict) -> str:
    return payload.get("project", {}).get("path_with_namespace", settings.default_gitlab_repo)


def _repo_context(repo: str) -> str:
    descs = settings.get_repo_descriptions()
    desc = descs.get(repo)
    return f"\nRepo description: {desc}\n" if desc else ""


def _resource_id(repo: str, resource_type: str, iid: int) -> str:
    sep = "!" if resource_type == "merge_request" else "#"
    return f"{repo}{sep}{iid}"


def _extract_jira_keys(*texts: str) -> list[str]:
    keys: list[str] = []
    seen: set[str] = set()
    for text in texts:
        for match in _JIRA_KEY_RE.findall(text):
            if match not in seen and not _JIRA_KEY_EXCLUDE_RE.search(match):
                keys.append(match)
                seen.add(match)
    return keys


async def _infer_conversation_from_jira(
    jira_keys: list[str], gitlab_resource_type: str, gitlab_resource_id: str,
) -> str | None:
    for key in jira_keys:
        conv_id = (
            await db.lookup_conversation("jira", "issue", key)
            or await db.get_conversation_for_jira_ticket(key)
            or await db.get_conversation_for_resource("jira", "issue", key)
        )
        if conv_id:
            await db.link_resource(conv_id, "gitlab", gitlab_resource_type, gitlab_resource_id)
            logger.info(
                "Auto-linked gitlab/%s/%s to conversation %s (via Jira %s)",
                gitlab_resource_type, gitlab_resource_id, conv_id, key,
            )
            return conv_id
    return None


def _is_ignored_user(username: str) -> bool:
    if not settings.ignore_usernames:
        return False
    ignored = {u.strip().lower() for u in settings.ignore_usernames.split(",")}
    return username.lower() in ignored


def _is_own_comment(body: str) -> bool:
    # Recognize Scooter's own comments; keep matching the legacy "OpenHands"
    # markers so in-flight threads created before the rename still match.
    return (
        body.startswith("Scooter is on it")
        or body.startswith("OpenHands is working on this.")
        or "OpenHands status:" in body
    )


def _response_instructions(noteable_type: str, noteable_iid: int) -> str:
    kind = "merge request" if noteable_type == "merge_requests" else "issue"
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, post an acknowledgment on GitLab so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up comment with your results.\n\n"
        f"To respond on GitLab {kind} {noteable_iid}, use the `gitlab_comment` tool with your comment `body` — "
        f"the target is already known."
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
    discussion_id: str | None = None, has_mention: bool = False,
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
            f"You were mentioned in a comment on GitLab {noteable_type.replace('_', ' ')} {iid_prefix}{noteable_iid}. "
            f"First, post an acknowledgment so the requester knows you've seen it. "
            f"Then work on the task. When finished, post a follow-up comment with your results."
        )
    else:
        preamble = (
            f"A new comment was posted on GitLab {noteable_type.replace('_', ' ')} {iid_prefix}{noteable_iid}. "
            f"This is for your awareness -- no action is required unless the comment explicitly asks you to do something."
        )

    return f"{preamble}\n\n---\n\n{comment_body}\n\n---\n\n{reply_instruction}"


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

    logger.info("Received GitLab event: %s", event_type)

    if event_type == "Note Hook":
        await _handle_note(payload)
    elif event_type == "Issue Hook":
        await _handle_issue(payload)
    elif event_type == "Merge Request Hook":
        await _handle_merge_request(payload)
    else:
        logger.debug("Ignoring GitLab event type: %s", event_type)

    return {"status": "ok"}


async def _handle_note(payload: dict):
    note = payload.get("object_attributes", {})
    note_body = note.get("note", "")
    user = payload.get("user", {}).get("username", "unknown")
    repo = _extract_repo(payload)
    noteable_type = note.get("noteable_type", "")

    if _is_ignored_user(user):
        return
    if _is_own_comment(note_body):
        return

    # Branch-specific fields, initialized so they're always bound (the later
    # noteable_type-gated blocks reference the ones relevant to their branch; the
    # unused-branch defaults are never read there, but binding them keeps the
    # control flow provably safe rather than "possibly unbound").
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
        context = f"Context: Issue #{issue_iid} '{issue_title}' in {repo}"
    else:
        return

    has_mention = _contains_mention(note_body)
    existing = (
        await db.lookup_conversation("gitlab", res_type, res_id)
        or await db.get_conversation_for_resource("gitlab", res_type, res_id)
    )

    # Try Jira cross-linking
    if not existing and noteable_type == "MergeRequest":
        mr_desc = mr.get("description", "")
        jira_keys = _extract_jira_keys(mr_title, source_branch, mr_desc)
        if jira_keys:
            existing = await _infer_conversation_from_jira(jira_keys, res_type, res_id)
    elif not existing and noteable_type == "Issue":
        issue_desc = issue.get("description", "")
        jira_keys = _extract_jira_keys(issue_title, issue_desc)
        if jira_keys:
            existing = await _infer_conversation_from_jira(jira_keys, res_type, res_id)

    if not has_mention and not existing:
        return

    message_text = note_body.replace(settings.mention_pattern, "").strip()
    diff_context = _format_diff_context(note)
    comment_body = f"{diff_context}\n\n@{user} commented:\n\n{message_text}" if diff_context else f"@{user} commented:\n\n{message_text}"

    if is_pending(existing):
        discussion_id = note.get("discussion_id")
        forward_msg = _format_forwarded_message(
            comment_body, project_id, note_api_type, noteable_iid,
            discussion_id=discussion_id, has_mention=has_mention,
        )
        await db.store_pending_message("gitlab", res_type, res_id, forward_msg)
        return

    if existing:
        discussion_id = note.get("discussion_id")
        forward_msg = _format_forwarded_message(
            comment_body, project_id, note_api_type, noteable_iid,
            discussion_id=discussion_id, has_mention=has_mention,
        )
        ok = await send_message(existing, forward_msg)
        if ok:
            return
        logger.warning("Failed to send to existing conversation %s, creating new one", existing)

    await db.store_conversation("gitlab", res_type, res_id, PENDING_CONVERSATION_ID)

    if noteable_type == "MergeRequest":
        conv_title = f"MR !{mr_iid}: {mr_title}"
    else:
        conv_title = f"Issue #{issue_iid}: {issue_title}"

    reply_hint = _response_instructions(note_api_type, noteable_iid)
    full_message = f"{context}\n{_repo_context(repo)}\n{comment_body}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            source="gitlab", res_type=res_type, res_id=res_id,
            message=full_message, repo=repo, conv_title=conv_title,
            project_id=project_id, note_api_type=note_api_type,
            noteable_iid=noteable_iid,
        )
    )


async def _handle_issue(payload: dict):
    action = payload.get("object_attributes", {}).get("action", "")
    labels = [l.get("title", "").lower() for l in payload.get("labels", [])]
    if action != "update" or settings.label_trigger.lower() not in labels:
        return

    issue = payload.get("object_attributes", {})
    repo = _extract_repo(payload)
    issue_title = issue.get("title", "")
    issue_desc = issue.get("description", "")
    issue_iid = issue.get("iid")
    project_id = payload.get("project", {}).get("id")
    res_id = _resource_id(repo, "issue", issue_iid)

    jira_keys = _extract_jira_keys(issue_title, issue_desc)
    if jira_keys:
        await _infer_conversation_from_jira(jira_keys, "issue", res_id)

    await db.store_conversation("gitlab", "issue", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions("issues", issue_iid)
    message = f"Issue #{issue_iid} '{issue_title}' in {repo}\n\n{issue_desc}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            source="gitlab", res_type="issue", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"Issue #{issue_iid}: {issue_title}",
            project_id=project_id, note_api_type="issues",
            noteable_iid=issue_iid,
        )
    )


async def _handle_merge_request(payload: dict):
    action = payload.get("object_attributes", {}).get("action", "")
    labels = [l.get("title", "").lower() for l in payload.get("labels", [])]
    if action != "update" or settings.label_trigger.lower() not in labels:
        return

    mr = payload.get("object_attributes", {})
    repo = _extract_repo(payload)
    mr_title = mr.get("title", "")
    mr_desc = mr.get("description", "")
    mr_iid = mr.get("iid")
    source_branch = mr.get("source_branch", "")
    project_id = payload.get("project", {}).get("id")
    res_id = _resource_id(repo, "merge_request", mr_iid)

    jira_keys = _extract_jira_keys(mr_title, source_branch, mr_desc)
    if jira_keys:
        await _infer_conversation_from_jira(jira_keys, "merge_request", res_id)

    await db.store_conversation("gitlab", "merge_request", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions("merge_requests", mr_iid)
    message = f"MR !{mr_iid} '{mr_title}' (branch: {source_branch}) in {repo}\n\n{mr_desc}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            source="gitlab", res_type="merge_request", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"MR !{mr_iid}: {mr_title}",
            project_id=project_id, note_api_type="merge_requests",
            noteable_iid=mr_iid,
        )
    )


async def _background_create_conversation(
    source: str, res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, project_id: int, note_api_type: str,
    noteable_iid: int,
) -> None:
    try:
        result = await create_conversation(message, repository=repo, title=conv_title)
        if not result:
            await _clear_pending(source, res_type, res_id)
            await post_gitlab_comment(
                project_id=project_id, noteable_type=note_api_type,
                noteable_iid=noteable_iid,
                body="Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        conv_id = result.get("conversation_id", "")
        await db.store_conversation(source, res_type, res_id, conv_id)
        conv_link = conversation_url(conv_id)

        # Surface the originating MR/issue and give the response tools a target.
        await push_link(
            conv_id, source="gitlab", resource_type=res_type,
            title=res_id,
            ref={"projectId": str(project_id), "mrIid": str(noteable_iid)},
        )

        # Flush pending messages
        messages = await db.get_and_clear_pending_messages(source, res_type, res_id)
        for msg in messages:
            ok = await send_message(conv_id, msg)
            if not ok:
                logger.warning("Failed to flush pending message to conversation %s", conv_id)

        await post_gitlab_comment(
            project_id=project_id, noteable_type=note_api_type,
            noteable_iid=noteable_iid,
            body=f"Scooter is on it — follow along: [View conversation]({conv_link})",
        )
    except Exception:
        await _clear_pending(source, res_type, res_id)
        logger.exception("Error in background conversation creation for %s", res_id)


async def _clear_pending(source: str, res_type: str, res_id: str) -> None:
    existing = await db.lookup_conversation(source, res_type, res_id)
    if is_pending(existing):
        await db.clear_conversation(source, res_type, res_id)
    await db.get_and_clear_pending_messages(source, res_type, res_id)
