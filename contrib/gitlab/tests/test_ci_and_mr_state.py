"""A linked MR's pipeline results and state changes reach its conversation, once each."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles

from scooter_contrib_gitlab import webhooks_handler as gitlab_h
from scooter_contrib_gitlab.config import settings
from scooter_schema.webhooks import Base as SchemaBase, ConversationVars as ConversationVar
from scooter_webhooks_lib import store
from scooter_webhooks_lib.agent_host_client import SendOutcome

REPO = "acme/infra"
MR_URL = "https://gitlab.com/acme/infra/-/merge_requests/313"


@compiles(JSONB, "sqlite")
def _jsonb_as_json_on_sqlite(type_, compiler, **kw):  # pragma: no cover - DDL shim
    """sqlite has no JSONB."""
    return "JSON"


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def db(monkeypatch):
    await store.init_db(_Config())

    # sqlite has no now(), which created_at and updated_at default to.
    @event.listens_for(store._engine.sync_engine, "connect")
    def _register_now(dbapi_conn, _record):  # pragma: no cover - DDL shim
        dbapi_conn.create_function(
            "now", 0, lambda: datetime.now(timezone.utc).isoformat(sep=" ")
        )

    async with store._engine.begin() as conn:
        await conn.run_sync(
            SchemaBase.metadata.create_all,
            tables=[store.ResourceLink.__table__, ConversationVar.__table__],
        )
    monkeypatch.setattr(gitlab_h.db, "lookup_conversation", AsyncMock(return_value=None))
    monkeypatch.setattr(settings, "gitlab_host", "gitlab.com")
    monkeypatch.setattr(gitlab_h, "get_own_username", AsyncMock(return_value="scooter-bot"))
    yield
    await store.close_db()


@pytest.fixture
def deliver(monkeypatch):
    mock = AsyncMock(return_value=SendOutcome.DELIVERED)
    monkeypatch.setattr(gitlab_h, "deliver_message", mock)
    return mock


@pytest.fixture
async def linked():
    await store.link_resource("conv-mr", "gitlab", "mr", MR_URL)


def _pipeline(status: str, pipeline_id: int = 100, with_mr: bool = True) -> dict:
    return {
        "object_attributes": {"id": pipeline_id, "status": status, "ref": "bump", "tag": False},
        "merge_request": {"iid": 313, "url": MR_URL, "source_branch": "bump"} if with_mr else None,
        "project": {"id": 9, "path_with_namespace": REPO, "web_url": "https://gitlab.com/acme/infra"},
        "builds": [
            {"name": "lint", "status": "failed", "allow_failure": False},
            {"name": "flaky", "status": "failed", "allow_failure": True},
            {"name": "test", "status": "success", "allow_failure": False},
        ],
    }


def _mr_event(action: str, user: str = "alice", updated_at: str = "2026-11-09 10:00:00 UTC") -> dict:
    return {
        "object_attributes": {
            "iid": 313, "action": action, "url": MR_URL, "target_branch": "main",
            "merge_commit_sha": "0123456789abcdef", "updated_at": updated_at,
        },
        "user": {"username": user},
        "project": {"id": 9, "path_with_namespace": REPO},
        "labels": [],
    }


async def test_a_failed_pipeline_forwards_once_naming_the_failed_jobs(deliver, linked):
    await gitlab_h._handle_pipeline(_pipeline("failed"))
    await gitlab_h._handle_pipeline(_pipeline("failed"))
    deliver.assert_awaited_once()
    conversation, message = deliver.await_args.args
    assert conversation == "conv-mr"
    assert "CI FAILED" in message and "- lint" in message and "flaky" not in message


async def test_a_pipeline_on_an_unlinked_mr_forwards_nothing(deliver):
    await gitlab_h._handle_pipeline(_pipeline("failed"))
    deliver.assert_not_awaited()


async def test_a_running_pipeline_forwards_nothing(deliver, linked):
    await gitlab_h._handle_pipeline(_pipeline("running"))
    deliver.assert_not_awaited()


async def test_success_forwards_only_after_a_failure(deliver, linked):
    await gitlab_h._handle_pipeline(_pipeline("success", 99))
    deliver.assert_not_awaited()
    await gitlab_h._handle_pipeline(_pipeline("failed", 100))
    await gitlab_h._handle_pipeline(_pipeline("success", 101))
    await gitlab_h._handle_pipeline(_pipeline("success", 102))
    assert [c.args[1].split(":")[0] for c in deliver.await_args_list] == ["CI FAILED", "CI is GREEN"]


async def test_an_older_pipeline_finishing_late_is_dropped(deliver, linked):
    await gitlab_h._handle_pipeline(_pipeline("failed", 100))
    await gitlab_h._handle_pipeline(_pipeline("success", 101))
    await gitlab_h._handle_pipeline(_pipeline("failed", 100))
    assert len(deliver.await_args_list) == 2


async def test_a_branch_pipeline_finds_its_mr_by_source_branch(deliver, linked, monkeypatch):
    lookup = AsyncMock(return_value=[313])
    monkeypatch.setattr(gitlab_h, "_open_mr_iids", lookup)
    await gitlab_h._handle_pipeline(_pipeline("failed", with_mr=False))
    lookup.assert_awaited_once_with(9, "bump")
    assert deliver.await_args.args[0] == "conv-mr"


async def test_a_merge_on_a_linked_mr_forwards_once(deliver, linked):
    await gitlab_h._handle_merge_request(_mr_event("merge"))
    await gitlab_h._handle_merge_request(_mr_event("merge"))
    deliver.assert_awaited_once()
    message = deliver.await_args.args[1]
    assert "MERGED by @alice into `main` (0123456789ab)" in message


async def test_a_second_approval_is_forwarded_again(deliver, linked):
    await gitlab_h._handle_merge_request(_mr_event("approved", updated_at="t1"))
    await gitlab_h._handle_merge_request(_mr_event("unapproved", updated_at="t2"))
    await gitlab_h._handle_merge_request(_mr_event("approved", updated_at="t3"))
    assert len(deliver.await_args_list) == 3


async def test_our_own_merge_is_not_forwarded(deliver, linked):
    await gitlab_h._handle_merge_request(_mr_event("merge", user="Scooter-Bot"))
    deliver.assert_not_awaited()


async def test_an_mr_update_without_the_label_forwards_nothing(deliver, linked):
    await gitlab_h._handle_merge_request(_mr_event("update"))
    deliver.assert_not_awaited()
