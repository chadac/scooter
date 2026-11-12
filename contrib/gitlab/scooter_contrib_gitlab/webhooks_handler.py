"""GitLab webhook handler.

A mention in a comment creates or forwards a conversation, the trigger label on an
issue or MR creates one, and any comment on a resource with an active conversation
is auto-forwarded, as are a linked MR's pipeline results and state changes.
"""

import asyncio
import hmac
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Request

from scooter_lib.attachments import MAX_IMAGE_BYTES, AttachmentRef, inline_images, refs_block
from scooter_lib.logging_config import format_error

from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending
from scooter_webhooks_lib.vars import ConversationVars

from . import attachments, merge_readiness
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
from .responses import GITLAB_API, get_own_username, post_gitlab_comment
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
    elif event_type == "Pipeline Hook":
        await _handle_pipeline(payload)
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
    existing = await _resolve_conversation(res_type, res_id, web_url)

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
    refs = attachments.parse_refs(note_body, project_id, settings.gitlab_host)
    comment_body += refs_block(attachments.TOOL, refs)

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
            noteable_iid=noteable_iid, invoking_user=user, sender=sender, refs=refs,
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
    refs = attachments.parse_refs(issue_desc, project_id, settings.gitlab_host)
    message = f"Issue #{issue_iid} '{issue_title}' in {repo}\n\n{issue_desc}{refs_block(attachments.TOOL, refs)}{reply_hint}"

    spawn(
        _background_create_conversation(
            source="gitlab", res_type="issue", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"Issue #{issue_iid}: {issue_title}",
            project_id=project_id, note_api_type="issues",
            invoking_user=payload.get("user", {}).get("username"),
            noteable_iid=issue_iid, event=payload, refs=refs,
        )
    )


async def _handle_merge_request(payload: dict):
    action = payload.get("object_attributes", {}).get("action", "")
    if action in _MR_STATE_ACTIONS:
        await _handle_mr_state(payload)
        return
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
    refs = attachments.parse_refs(mr_desc, project_id, settings.gitlab_host)
    message = (
        f"MR !{mr_iid} '{mr_title}' (branch: {source_branch}) in {repo}\n\n"
        f"{mr_desc}{refs_block(attachments.TOOL, refs)}{reply_hint}"
    )

    spawn(
        _background_create_conversation(
            source="gitlab", res_type="merge_request", res_id=res_id,
            message=message, repo=repo,
            conv_title=f"MR !{mr_iid}: {mr_title}",
            project_id=project_id, note_api_type="merge_requests",
            invoking_user=payload.get("user", {}).get("username"),
            noteable_iid=mr_iid, event=payload, refs=refs,
        )
    )


async def _resolve_conversation(res_type: str, res_id: str, web_url: str | None = None) -> str | None:
    """The conversation linked to this resource, by short form or by URL."""
    return (
        await db.lookup_conversation("gitlab", res_type, res_id)
        or await db.get_conversation_for_resource("gitlab", res_type, res_id)
        # A link stored under a URL the configured host can't rebuild.
        or (web_url and await db.get_conversation_for_resource("gitlab", res_type, web_url))
        or None
    )


async def _linked_conversation(res_id: str, web_url: str | None) -> str | None:
    """The started conversation linked to this MR; an unlinked MR is not ours."""
    conversation = await _resolve_conversation("merge_request", res_id, web_url)
    return None if not conversation or is_pending(conversation) else conversation


async def _forward_once(conversation: str, res_id: str, message: str, key: str, value: dict) -> None:
    """Forward `message` unless `value` was already forwarded under `key`."""
    if not await ConversationVars(conversation, "gitlab").claim(key, value):
        return
    outcome = await deliver_message(conversation, message, source="gitlab")
    logger.info(
        "forwarded event to conversation",
        extra={
            **_C,
            "conversation_id": conversation,
            "outcome": outcome.value,
            "source": "gitlab",
            "resource_type": "merge_request",
            "resource_id": res_id,
            "key": key.split(":", 1)[0],
        },
    )


async def _merge_blockers(project_id: int | str, iid: int) -> list[merge_readiness.Blocker] | None:
    """What holds an open MR's merge, or None when it is closed or unreadable."""
    if not settings.gitlab_token or not project_id or not iid:
        return None
    project = f"{GITLAB_API}/projects/{project_id}"
    base = f"{project}/merge_requests/{iid}"
    try:
        async with httpx.AsyncClient(timeout=15, headers={"PRIVATE-TOKEN": settings.gitlab_token}) as client:
            mr, settings_resp, approvals, discussions = await asyncio.gather(
                client.get(base), client.get(project), client.get(f"{base}/approvals"),
                client.get(f"{base}/discussions", params={"per_page": 100}),
            )
            mr.raise_for_status()
            data = mr.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "merge-blocker lookup failed; forwarding without it",
            extra={**_C, "source": "gitlab", "error": format_error(e)},
        )
        return None
    if data.get("state") != "opened":
        return None
    # Webhooks read as the deployment token, not the agent's identity.
    return merge_readiness.blockers(
        data, project=_body(settings_resp), approvals=_body(approvals), discussions=_body(discussions),
    )


def _body(resp: httpx.Response) -> Any:
    """A successful response's JSON, else None."""
    if not resp.is_success:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


async def _merge_note(project_id: int | str, iid: int) -> str:
    """The required blockers as a message tail; "" when they can't be read."""
    found = await _merge_blockers(project_id, iid)
    return "" if found is None else "\n\n" + merge_readiness.note(found)


_MR_STATE_ACTIONS = {
    "merge": "was MERGED",
    "close": "was CLOSED WITHOUT MERGING",
    "reopen": "was REOPENED",
    "approved": "is now APPROVED",
    "unapproved": "is NO LONGER APPROVED",
}

_MR_STATE_HINTS = {
    "merge": "The branch is done: do not push more commits to it. Follow-up work needs a new branch off the updated `{target}`.",
    "close": "Stop work on this MR unless asked otherwise. Check the thread for why it was closed.",
    "reopen": "Check the thread for why it was reopened before picking the work back up.",
    "approved": "No action needed unless you were waiting on approval to merge or mark it ready.",
    "unapproved": "Check the thread for what changed before merging.",
}


async def _handle_mr_state(payload: dict) -> None:
    """Merge Request Hook merge/close/reopen/approval: tell the linked conversation."""
    mr = payload.get("object_attributes", {})
    action = mr.get("action", "")
    user = payload.get("user", {}).get("username", "unknown")
    own = await get_own_username()
    if own and user.lower() == own.lower():
        return

    repo = _extract_repo(payload)
    iid = mr.get("iid")
    res_id = _resource_id(repo, "merge_request", iid)
    conversation = await _linked_conversation(res_id, mr.get("url"))
    if not conversation:
        return
    target = mr.get("target_branch") or "the target branch"
    sha = mr.get("merge_commit_sha") or ""
    into = f" into `{target}`" if action == "merge" else ""
    commit = f" ({sha[:12]})" if action == "merge" and sha else ""
    message = (
        f"MR !{iid} in {repo} {_MR_STATE_ACTIONS[action]} by @{user}{into}{commit}.\n\n---\n\n"
        + _MR_STATE_HINTS[action].format(target=target)
        + (await _merge_note(payload.get("project", {}).get("id"), iid) if action == "approved" else "")
    )
    # updated_at tells a repeated delivery from a second reopen or approval.
    await _forward_once(
        conversation, res_id, message,
        f"mr_state:{res_id}", {"action": action, "at": mr.get("updated_at")},
    )


async def _open_mr_iids(project_id: int, branch: str) -> list[int]:
    """The iids of the open MRs from `branch`, or [] when the lookup fails."""
    if not settings.gitlab_token or not project_id or not branch:
        return []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITLAB_API}/projects/{project_id}/merge_requests",
                headers={"PRIVATE-TOKEN": settings.gitlab_token},
                params={"source_branch": branch, "state": "opened", "per_page": 20},
            )
            resp.raise_for_status()
            return [mr["iid"] for mr in resp.json() if mr.get("iid")]
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "open-MR lookup failed; dropping the pipeline event",
            extra={**_C, "source": "gitlab", "project_id": project_id, "error": format_error(e)},
        )
        return []


async def _handle_pipeline(payload: dict) -> None:
    """Pipeline Hook: forward a failure, and a success that follows a forwarded failure."""
    pipeline = payload.get("object_attributes", {})
    status = pipeline.get("status")
    if status not in ("failed", "success") or pipeline.get("tag"):
        return

    repo = _extract_repo(payload)
    mr = payload.get("merge_request") or {}
    if mr.get("iid"):
        iids, web_url = [mr["iid"]], mr.get("url")
    else:
        iids, web_url = await _open_mr_iids(payload.get("project", {}).get("id"), pipeline.get("ref", "")), None

    pipeline_id = pipeline.get("id") or 0
    url = pipeline.get("url") or f"{payload.get('project', {}).get('web_url', '')}/-/pipelines/{pipeline_id}"
    branch = mr.get("source_branch") or pipeline.get("ref", "")
    failed = [
        b.get("name", "?") for b in payload.get("builds") or []
        if b.get("status") == "failed" and not b.get("allow_failure")
    ]
    for iid in iids:
        res_id = _resource_id(repo, "merge_request", iid)
        await _forward_pipeline(
            res_id, web_url, payload.get("project", {}).get("id"), iid, branch, pipeline_id, status, url, failed,
        )


async def _forward_pipeline(
    res_id: str, web_url: str | None, project_id: int | None, iid: int, branch: str,
    pipeline_id: int, status: str, url: str, failed: list[str],
) -> None:
    conversation = await _linked_conversation(res_id, web_url)
    if not conversation:
        return
    key = f"pipeline:{res_id}"
    last = await ConversationVars(conversation, "gitlab").get(key) or {}
    # An older pipeline finishing late says nothing about the MR now.
    if (last.get("id") or 0) > pipeline_id:
        return
    if status == "success":
        if last.get("status") != "failed":
            return
        message = (
            f"CI is GREEN: pipeline #{pipeline_id} passes on `{branch}` (MR !{iid}).\n\n{url}\n\n---\n\n"
            "The previous pipeline failed, so this unblocks the MR. "
            "No action needed unless you were waiting to do something after CI."
            + await _merge_note(project_id, iid)
        )
    else:
        listed = "\n".join(f"- {j}" for j in failed) if failed else "- (job names unavailable)"
        message = (
            f"CI FAILED: pipeline #{pipeline_id} on `{branch}` (MR !{iid}).\n\n"
            f"Failing jobs:\n{listed}\n\n{url}\n\n---\n\n"
            "Investigate before pushing again: read the failing job's log rather than "
            "guessing. If it is a known flake, say so explicitly rather than silently re-running."
        )
    await _forward_once(conversation, res_id, message, key, {"id": pipeline_id, "status": status})


async def _first_message_images(refs: list[AttachmentRef]) -> list[dict]:
    """The images that start a conversation, fetched now so the agent sees them on its first turn.

    A failure costs only the images, never the conversation.
    """
    try:
        if not any(r.image for r in refs):
            return []
        async with httpx.AsyncClient(timeout=30) as client:

            async def api_get(path: str) -> httpx.Response:
                return await client.get(
                    f"https://{settings.gitlab_host}/{path}", headers={"PRIVATE-TOKEN": settings.gitlab_token},
                )

            async def fetch(ref: AttachmentRef):
                _, fetched = await attachments.fetch(ref.ref, api_get, client, max_bytes=MAX_IMAGE_BYTES)
                return fetched

            return await inline_images(refs, fetch)
    except Exception:
        logger.warning("first-message images failed; starting without them", extra={**_C, "source": "gitlab"}, exc_info=True)
        return []


async def _background_create_conversation(
    source: str, res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, project_id: int, note_api_type: str,
    noteable_iid: int, invoking_user: str | None = None,
    sender: Sender | None = None, event: dict | None = None,
    refs: list[AttachmentRef] | None = None,
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
            images=await _first_message_images(refs or []) or None,
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
