"""scooter_lib — shared, service-agnostic library for Scooter's Python services.

Holds logic common to ALL Python services (broker, webhooks, scheduler, …) and
therefore usable by contribs too. Neither of the two extension surfaces
(`scooter_broker_lib` / `scooter_webhooks_lib`) — those build on THIS.

Planned contents (moved in per the boundary agreed on the PR):
  * logging_config — the structured-logging convention (JSON line format,
    `format_error`, `configure_logging`). Today duplicated (and drifted) across
    broker/webhooks; this becomes the single source, parameterized by service name.

This module is a skeleton pending the boundary sign-off; contents land in
follow-up commits on the same PR.
"""
