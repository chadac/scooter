"""Test configuration - set environment for test imports."""

import os

# Set STORE_BACKEND=sqlite BEFORE any imports so module-level settings instantiation works.
# Individual tests can override this with monkeypatch if they need to test specific configs.
os.environ.setdefault("STORE_BACKEND", "sqlite")
