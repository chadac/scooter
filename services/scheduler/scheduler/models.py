"""Pydantic API models + SQLAlchemy ORM tables for scheduled tasks + runs."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel
from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# --- ORM ----------------------------------------------------------------------

class Base(DeclarativeBase):
    pass


class TaskRow(Base):
    __tablename__ = "scheduled_tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    cron: Mapped[str] = mapped_column(String, nullable=False)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="UTC")
    # The Scooter user who created the task; set as the owner of every conversation
    # it spawns (task owner == conversation owner).
    owner: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RunRow(Base):
    __tablename__ = "task_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    task_id: Mapped[str] = mapped_column(String, ForeignKey("scheduled_tasks.id", ondelete="CASCADE"), nullable=False)
    conversation_id: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False)  # spawning|spawned|failed
    error: Mapped[str | None] = mapped_column(Text)
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --- API models ---------------------------------------------------------------

class TaskCreate(BaseModel):
    title: str
    prompt: str
    cron: str
    timezone: str = "UTC"
    enabled: bool = True
    # owner is NOT accepted from the body — it's the authenticated request identity
    # (so a user can't create tasks owned by someone else). Set server-side.


class TaskPatch(BaseModel):
    title: str | None = None
    prompt: str | None = None
    cron: str | None = None
    timezone: str | None = None
    enabled: bool | None = None


class Task(BaseModel):
    id: str
    title: str
    prompt: str
    cron: str
    timezone: str
    owner: str
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None

    @classmethod
    def of(cls, r: TaskRow) -> "Task":
        return cls(
            id=r.id, title=r.title, prompt=r.prompt, cron=r.cron, timezone=r.timezone,
            owner=r.owner, enabled=r.enabled, next_run_at=r.next_run_at, last_run_at=r.last_run_at,
        )


class Run(BaseModel):
    id: str
    task_id: str
    conversation_id: str | None
    status: str
    error: str | None
    fired_at: datetime

    @classmethod
    def of(cls, r: RunRow) -> "Run":
        return cls(
            id=r.id, task_id=r.task_id, conversation_id=r.conversation_id,
            status=r.status, error=r.error, fired_at=r.fired_at,
        )


def new_id() -> str:
    return str(uuid.uuid4())
