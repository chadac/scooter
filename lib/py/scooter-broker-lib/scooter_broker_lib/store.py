"""Shared async-DB plumbing: the broker DSN, and the one place an engine is built.

Every broker store — the module registry, static shares, aws's permission requests,
and whatever a contrib owns next — reaches the SAME database (`broker` on the shared
Postgres) and needs the same reconnect guards, so the assembly lives here rather than
inside any one of them. It lived in `broker.aws.store` until PR #622, which meant
`broker/core/app.py`, `registry/` and `shares/` each imported the aws subsystem just
to open a connection — and aws's provider cannot become a contrib while they do.

`pool_pre_ping` + `pool_recycle` are not tuning. Without them the pool hands out a
connection a Postgres restart/failover has already closed; the request dies with
asyncpg "connection is closed" and the service stays broken until it is ITSELF
restarted (webhooks learned this in production). Every store opening its engine
through `open_sessions` is what makes that structural instead of a list of files
someone has to remember to extend — the list had already missed shares/store.py.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Under typical idle-timeout windows (and the resilience test's 3600s ceiling).
POOL_RECYCLE_SECONDS = 1800


@dataclass
class StoreConfig:
    """DSN assembly mirroring the webhooks DatabaseSettings: an explicit `dsn`
    wins; otherwise, when `db_password` is set, build
    postgresql+asyncpg://{user}:{pw}@{host}:{port}/{name}. Default = SQLite.

    The password arrives as its own component so a k8s secretKeyRef can supply it
    without a full connection string — password included — in the manifest.
    """

    dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    db_port: int = 5432
    db_user: str = "webhooks"   # shared instance's user; DB name differs
    db_password: str = ""
    db_name: str = "broker"     # SEPARATE database on the shared Postgres
    db_sslmode: str = ""        # "require" etc.; empty = no ssl param

    def resolved_dsn(self) -> str:
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            # asyncpg takes ssl as a query param, not libpq's sslmode= — same
            # mapping as webhooks/scheduler. Dropping it connects in cleartext to a
            # server the deployment asked to reach over TLS, and says nothing.
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            return dsn
        return self.dsn


def open_sessions(
    config: StoreConfig,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """The engine + session factory for `config`, with the reconnect guards applied.

    Both are returned: a store works through the sessionmaker and disposes of the
    engine. `expire_on_commit=False` so a dataclass built from a row stays readable
    once the transaction has closed.
    """
    engine = create_async_engine(
        config.resolved_dsn(),
        echo=False,
        pool_pre_ping=True,
        pool_recycle=POOL_RECYCLE_SECONDS,
    )
    return engine, async_sessionmaker(engine, expire_on_commit=False)
