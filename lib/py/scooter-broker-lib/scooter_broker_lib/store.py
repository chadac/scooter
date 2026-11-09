"""Shared async-DB plumbing: the broker DSN, and the one place an engine is built.

Every broker store (and every contrib store, each in its own database) opens its engine
through `open_sessions`, so all share one pool shape. There is no `pool_pre_ping`: it costs a
round trip per checkout, while PgBouncer in transaction mode absorbs Postgres restarts and
SQLAlchemy drops the pool on the first disconnect error. `pool_recycle` retires connections
before idle timeouts close them.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Under typical idle-timeout windows.
POOL_RECYCLE_SECONDS = 1800
# The broker opens one engine per store, so each stays small under max_connections.
# No overflow: an overflow connection is redialled every use.
POOL_SIZE = 5
MAX_OVERFLOW = 0


@dataclass
class StoreConfig:
    """DSN assembly: an explicit `dsn` wins, otherwise a Postgres DSN is built from the components when `db_password` (its own field so a secretKeyRef can supply it) is set."""

    dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    db_port: int = 5432
    db_user: str = "webhooks"   # the shared instance's user
    db_password: str = ""
    db_name: str = "broker"     # a separate database on the shared Postgres
    db_sslmode: str = ""        # "require" etc.; empty adds no ssl param

    def resolved_dsn(self) -> str:
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            # asyncpg takes ssl as a query param, not libpq's sslmode=.
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            return dsn
        return self.dsn

    def with_database(self, db_name: str) -> "StoreConfig":
        """The same server and credentials against another database (a contrib's own); a dev SQLite DSN is left as is."""
        dsn = self.dsn
        if dsn.startswith("postgresql"):
            dsn = make_url(dsn).set(database=db_name).render_as_string(hide_password=False)
        return replace(self, dsn=dsn, db_name=db_name)


def open_sessions(
    config: StoreConfig,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """The engine and session factory for `config` with the shared pool settings; `expire_on_commit=False` keeps a row readable after its transaction closes."""
    dsn = config.resolved_dsn()
    # SQLite's single-connection pools reject the sizing arguments.
    sizing = {"pool_size": POOL_SIZE, "max_overflow": MAX_OVERFLOW} if dsn.startswith("postgresql") else {}
    engine = create_async_engine(
        dsn,
        echo=False,
        pool_recycle=POOL_RECYCLE_SECONDS,
        **sizing,
    )
    return engine, async_sessionmaker(engine, expire_on_commit=False)
