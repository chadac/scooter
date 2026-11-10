"""A note on a linked MR or issue reaches its conversation whatever shape the link was stored in."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles

from scooter_contrib_gitlab import webhooks_handler as gitlab_h
from scooter_contrib_gitlab.config import settings
from scooter_schema.webhooks import Base as SchemaBase
from scooter_webhooks_lib import store, tasks
from scooter_webhooks_lib.agent_host_client import SendOutcome

MR_URL = "https://gitlab.com/acme/devops/infra/-/merge_requests/313"
ISSUE_URL = "https://gitlab.com/acme/devops/infra/-/issues/42"


@compiles(JSONB, "sqlite")
def _jsonb_as_json_on_sqlite(type_, compiler, **kw):  # pragma: no cover - DDL shim
    """sqlite has no JSONB, and these tests only need the column to exist."""
    return "JSON"


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def db(monkeypatch):
    await store.init_db(_Config())

    # sqlite has no now(), which resource_links.created_at defaults to.
    @event.listens_for(store._engine.sync_engine, "connect")
    def _register_now(dbapi_conn, _record):  # pragma: no cover - DDL shim
        dbapi_conn.create_function(
            "now", 0, lambda: datetime.now(timezone.utc).isoformat(sep=" ")
        )

    # Only resource_links: conversation_map's postgres-only DDL can't render on sqlite.
    async with store._engine.begin() as conn:
        await conn.run_sync(
            SchemaBase.metadata.create_all, tables=[store.ResourceLink.__table__]
        )
    monkeypatch.setattr(gitlab_h.db, "lookup_conversation", AsyncMock(return_value=None))
    monkeypatch.setattr(settings, "gitlab_host", "gitlab.com")
    yield
    await store.close_db()


@pytest.fixture
def deliver(monkeypatch):
    mock = AsyncMock(return_value=SendOutcome.DELIVERED)
    monkeypatch.setattr(gitlab_h, "deliver_message", mock)
    monkeypatch.setattr(gitlab_h, "sender_of", AsyncMock(return_value=None))
    return mock


def _mr_note(url: str | None = MR_URL, body: str = "looks good") -> dict:
    mr = {"iid": 313, "title": "Bump", "source_branch": "bump", "description": ""}
    if url:
        mr["url"] = url
    return {
        "object_attributes": {"note": body, "noteable_type": "MergeRequest", "id": 4152098569},
        "user": {"username": "alice"},
        "project": {"id": 9, "path_with_namespace": "acme/devops/infra"},
        "merge_request": mr,
    }


def _issue_note(url: str | None = ISSUE_URL) -> dict:
    issue = {"iid": 42, "title": "Broken", "description": ""}
    if url:
        issue["url"] = url
    return {
        "object_attributes": {"note": "any update?", "noteable_type": "Issue", "id": 7},
        "user": {"username": "alice"},
        "project": {"id": 9, "path_with_namespace": "acme/devops/infra"},
        "issue": issue,
    }


async def test_a_plain_note_reaches_the_conversation_linked_by_mr_url(deliver):
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    await gitlab_h._handle_note(_mr_note())
    assert deliver.await_args.args[0] == "conv-mr"


async def test_a_plain_note_reaches_the_conversation_linked_by_issue_url(deliver):
    await store.link_resource("conv-issue", "gitlab", "issue", ISSUE_URL)
    await gitlab_h._handle_note(_issue_note())
    assert deliver.await_args.args[0] == "conv-issue"


async def test_the_short_form_alone_finds_a_url_link_on_the_configured_host(deliver):
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    await gitlab_h._handle_note(_mr_note(url=None))
    assert deliver.await_args.args[0] == "conv-mr"


async def test_the_payload_url_finds_a_link_on_another_host(deliver, monkeypatch):
    monkeypatch.setattr(settings, "gitlab_host", "gitlab.internal")
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    await gitlab_h._handle_note(_mr_note())
    assert deliver.await_args.args[0] == "conv-mr"


async def test_an_unlinked_note_without_mention_is_ignored_and_logged(deliver, caplog):
    with caplog.at_level(logging.INFO, logger=gitlab_h.logger.name):
        await gitlab_h._handle_note(_mr_note())
    deliver.assert_not_awaited()
    assert "note on unlinked resource without mention; ignoring" in caplog.text


@pytest.fixture
def own_username(monkeypatch):
    monkeypatch.setattr(gitlab_h, "get_own_username", AsyncMock(return_value="Scooter-Bot"))


async def test_a_note_by_our_own_user_is_dropped(deliver, own_username):
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    note = _mr_note(body="Intentional. One broker per cluster.")
    note["user"]["username"] = "scooter-bot"
    await gitlab_h._handle_note(note)
    deliver.assert_not_awaited()


async def test_our_own_user_mentioning_the_agent_still_reaches_it(deliver, own_username):
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    note = _mr_note(body="@agent please rebase")
    note["user"]["username"] = "scooter-bot"
    await gitlab_h._handle_note(note)
    assert deliver.await_args.args[0] == "conv-mr"


async def test_the_route_answers_before_the_forward_finishes(deliver, monkeypatch):
    monkeypatch.setattr(settings, "gitlab_webhook_secret", "s3cret")
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    release = asyncio.Event()

    async def slow_run(*_a, **_k):
        await release.wait()
        return SendOutcome.DELIVERED

    deliver.side_effect = slow_run
    app = FastAPI()
    app.include_router(gitlab_h.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        resp = await asyncio.wait_for(
            client.post(
                "/webhooks/gitlab",
                headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": "s3cret"},
                json=_mr_note(),
            ),
            timeout=5,
        )
    assert resp.status_code == 200
    release.set()
    await tasks.drain(timeout=5)
    assert deliver.await_args.args[0] == "conv-mr"


async def test_a_note_with_an_upload_forwards_its_ref(deliver):
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)
    secret = "0123456789abcdef0123456789abcdef"
    await gitlab_h._handle_note(_mr_note(body=f"see ![shot](/uploads/{secret}/shot.png)"))
    message = deliver.await_args.args[1]
    assert f"- shot.png (image), ref: `gl:9:{secret}/shot.png`" in message
    assert "gitlab_attachment(ref)" in message
