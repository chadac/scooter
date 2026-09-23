"""Airtable settings, owned by this contrib rather than the broker app.

Same env var the broker read before (AIRTABLE_TOKEN), so a deployment needs no
manifest change. Why: PR #573.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class AirtableSettings(ScooterBaseSettings):
    airtable_token: str = ""
