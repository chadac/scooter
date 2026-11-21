"""The curated catalog, shipped as catalog.json beside this module."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources


@lru_cache(maxsize=1)
def catalog() -> list[dict]:
    """Entries exactly as the settings UI shows them."""
    raw = json.loads(resources.files(__package__).joinpath("catalog.json").read_text())
    return raw["servers"]
