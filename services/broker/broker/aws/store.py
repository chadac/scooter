"""Permission-request store — durable record of the request lifecycle.

DESIGN BOILERPLATE. Backed by the SHARED Postgres (`agent-webhooks-db` in the
agent-manager namespace) on a SEPARATE database (`broker`), via SQLAlchemy
async + asyncpg — the same DSN-from-components + secretKeyRef pattern the
webhooks store uses. SQLite (aiosqlite) is the local/dev default. See the
storage-consolidation TODO in docs/AWS_PERMISSIONS_BROKER.md.

STS credentials are NEVER stored here — they live in an in-memory cache
(service.py) until retrieved or expired. Durability lesson from the webhooks
store: AWAIT writes (don't fire-and-forget) so a crash can't lose a row.
"""

from __future__ import annotations

from typing import Any

from .models import PermissionRequest, RequestStatus


class StoreConfig:
    """DSN assembly mirroring the webhooks DatabaseSettings: an explicit `dsn`
    wins; otherwise, when `db_password` is set, build
    postgresql+asyncpg://{user}:{pw}@{host}:{port}/{name}. Default = SQLite."""

    dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    db_host: str = "agent-webhooks-db.agent-manager.svc.cluster.local"
    db_port: int = 5432
    db_user: str = "webhooks"   # shared instance's user; DB name differs
    db_password: str = ""
    db_name: str = "broker"     # SEPARATE database on the shared Postgres


class PermissionStore:
    """Persists PermissionRequest rows + the conversation↔request index.

    Cross-conversation isolation: get_for_conversation only returns a request to
    the conversation that created it (identity from the SA token). Async to match
    the broker's FastAPI/asyncpg stack.
    """

    def __init__(self, config: StoreConfig) -> None:
        raise NotImplementedError

    async def init(self) -> None:
        """Create tables if absent (SQLAlchemy create_all — no migrations, like
        the webhooks store)."""
        raise NotImplementedError

    async def insert(self, request: PermissionRequest) -> None:
        raise NotImplementedError

    async def get(self, request_id: str) -> PermissionRequest | None:
        raise NotImplementedError

    async def get_for_conversation(self, request_id: str, conversation_id: str) -> PermissionRequest | None:
        """The request ONLY if it belongs to `conversation_id` (isolation)."""
        raise NotImplementedError

    async def update(self, request_id: str, **fields: Any) -> None:
        """Patch fields (status transitions, IAM ARNs, timestamps, approver).
        AWAITED so the row is durable before the caller proceeds."""
        raise NotImplementedError

    async def list_for_conversation(self, conversation_id: str) -> list[PermissionRequest]:
        raise NotImplementedError

    async def list_expired_active(self, now_iso: str) -> list[PermissionRequest]:
        """active/approved requests whose role_expires_at <= now — the cleanup
        sweep targets these."""
        raise NotImplementedError

    async def query_audit(
        self,
        *,
        conversation_id: str | None = None,
        target_account: str | None = None,
        status: RequestStatus | None = None,
        limit: int = 100,
    ) -> list[PermissionRequest]:
        raise NotImplementedError
