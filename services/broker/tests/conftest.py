"""Test configuration - set environment for test imports.

The broker's StoreConfig defaults to store_backend=postgres, which requires a
db_password. Tests use SQLite (no password needed), so this conftest sets
STORE_BACKEND=sqlite BEFORE any imports that might instantiate settings.
"""

import os

# Set STORE_BACKEND=sqlite BEFORE any imports so module-level settings instantiation works.
# Individual tests can override this with monkeypatch if they need to test specific configs.
os.environ.setdefault("STORE_BACKEND", "sqlite")
