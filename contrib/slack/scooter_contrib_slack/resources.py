"""Slack's resource shapes: which type spellings name the same thread.

Registered into `scooter_webhooks_lib.resources` (#576). A Slack id has ONE
spelling — `channel:thread_ts`, with no URL form a webhook ever arrives as — so
aliases are all there is and `id_variants` stays the default. Why: PR #588.
"""

from __future__ import annotations

from scooter_webhooks_lib.resources import ResourceShapes, register_resource_shapes

register_resource_shapes(
    "slack",
    ResourceShapes(type_aliases={"message": "thread", "thread": "thread"}),
)
