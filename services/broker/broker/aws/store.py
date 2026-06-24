"""Permission-request store — durable record of the request lifecycle.

DESIGN BOILERPLATE. SQLite on a PVC to start (single-replica), with the same
durability lesson as the webhooks store (await writes; flush before returning).
STS credentials are NEVER stored here — they live in an in-memory cache
(service.py) until the agent retrieves them or they expire.
"""

from __future__ import annotations

from typing import Any

from .models import PermissionRequest, RequestStatus


class PermissionStore:
    """Persists PermissionRequest rows + the conversation↔request index.

    Cross-conversation isolation: get_request_for_conversation only returns a
    request to the conversation that created it (identity from the SA token).
    """

    def __init__(self, db_path: str) -> None:
        raise NotImplementedError

    def init(self) -> None:
        """Create tables if absent (idempotent)."""
        raise NotImplementedError

    def insert(self, request: PermissionRequest) -> None:
        raise NotImplementedError

    def get(self, request_id: str) -> PermissionRequest | None:
        raise NotImplementedError

    def get_for_conversation(self, request_id: str, conversation_id: str) -> PermissionRequest | None:
        """The request ONLY if it belongs to `conversation_id` (isolation)."""
        raise NotImplementedError

    def update(self, request_id: str, **fields: Any) -> None:
        """Patch fields (status transitions, IAM ARNs, timestamps, approver)."""
        raise NotImplementedError

    def list_for_conversation(self, conversation_id: str) -> list[PermissionRequest]:
        raise NotImplementedError

    def list_expired_active(self, now_iso: str) -> list[PermissionRequest]:
        """active/approved requests whose role_expires_at <= now — the cleanup
        sweep targets these."""
        raise NotImplementedError

    def query_audit(
        self,
        *,
        conversation_id: str | None = None,
        target_account: str | None = None,
        status: RequestStatus | None = None,
        limit: int = 100,
    ) -> list[PermissionRequest]:
        raise NotImplementedError
