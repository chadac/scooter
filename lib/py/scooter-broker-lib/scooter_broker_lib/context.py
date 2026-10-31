"""What the broker hands a provider: the deployment-level substrate a provider must not build itself.

The `authorizer` is the enforcement point and the `store_config` is the shared
`broker` database's DSN. `owners` says whose personal credentials a request may
use and `user_secrets` encrypts them at rest. The app builds all of them once and
passes them to any factory that declares a parameter. A contrib that owns tables reaches its OWN database
through `contrib_store_config`, with the same credentials.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .authz import Authorizer
from .owner import OwnerResolver
from .store import StoreConfig
from .user_secrets import SecretBox


def contrib_db_name(contrib: str) -> str:
    """The database `contribs.<contrib>.db` names: `CONTRIB_<NAME>_DB_NAME` as the platform renders it, else its default."""
    slug = contrib.replace("-", "_")
    return os.environ.get(f"CONTRIB_{slug.upper()}_DB_NAME") or f"contrib_{slug}"


@dataclass(frozen=True)
class BrokerContext:
    """Substrate the broker supplies to a provider factory that asks for it."""

    authorizer: Authorizer
    store_config: StoreConfig
    # None only in a test context built without them.
    owners: OwnerResolver | None = None
    user_secrets: SecretBox | None = None

    def contrib_store_config(self, contrib: str) -> StoreConfig:
        """`store_config` pointed at `contrib`'s own database.

        Roles stay per service, so only the database changes: the contrib connects
        as the broker, to a database whose schema and Atlas history are its own.
        """
        return self.store_config.with_database(contrib_db_name(contrib))
