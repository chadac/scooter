"""scooter_lib — shared, service-agnostic library for Scooter's Python services.

Holds logic common to ALL Python services (broker, webhooks, scheduler, …) and
therefore usable by contribs too. Neither of the two extension surfaces
(`scooter_broker_lib` / `scooter_webhooks_lib`) — those build on THIS.

Contents:
  * logging_config — the structured-logging convention (JSON line format,
    `format_error`, `configure_logging`). Was duplicated and drifted across
    broker/webhooks/scheduler; this is the single source, with `service` and the
    `component` prefix as parameters.

Nothing here may import a service app or either extension-surface lib.
"""

from .logging_config import configure_logging, format_error, get_logger

__all__ = ["configure_logging", "format_error", "get_logger"]
