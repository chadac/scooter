"""Static shares — broker-hosted static webpages that persist past a session.

An agent publishes a bundle of static files (a single file, or a zip that the
broker unpacks); the broker mints a UUID and serves the bundle at a stable,
capability-style URL:

    https://<host>/s/<uuid>/            -> the bundle's entry point (index.html)
    https://<host>/s/<uuid>/<path>      -> any file in the bundle
    https://<host>/s/<uuid>/v/<n>/...   -> a specific version

The UUID *is* the identity (broker-minted, unguessable) — there is no page name
in the URL. Ownership lives in the DB row keyed by that UUID, not the path.
Updating a share keeps the same UUID and adds a new version; the root always
serves the latest. Files live on the shared broker Postgres (like the module
registry) — see shares/store.py.

⚠️ SCHEMA SEAM: the persistence layer (tables + row<->dataclass mapping) is
isolated in shares/store.py. A declarative-schema refactor should only need to
touch that file — routes, zip ingest, validation, and serving go through the
ShareStore API and never see the schema.
"""
