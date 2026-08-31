"""scooter_schema — generated SQLAlchemy models for Scooter's shared databases.

Tables live in one module per database (they are physically separate databases;
``remote_agents`` even exists in two with different columns). Import only the
database you own::

    from scooter_schema import webhooks
    from scooter_schema.guard import assert_database
    await assert_database(conn, "webhooks")

The per-database modules are GENERATED from lib/sql/<db>/schema.sql by
``just db-generate`` — do not hand-edit them. ``guard`` is not generated.
"""

from . import broker, byoc, scheduler, webhooks
from .guard import assert_database, assert_database_sync, check_database

__all__ = [
    "webhooks",
    "scheduler",
    "broker",
    "byoc",
    "assert_database",
    "assert_database_sync",
    "check_database",
]
