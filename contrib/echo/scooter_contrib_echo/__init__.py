"""scooter-contrib-echo — the reference Scooter contrib module.

A contrib is a self-contained package that plugs into one or more Scooter
services through entry points, without editing any service's core:

  * ``agent_broker.providers``    -> broker provider  (broker_provider.py)
  * ``scooter_webhooks.handlers`` -> webhooks handler (webhooks_handler.py)

This top-level module stays import-light on purpose: it pulls in NEITHER
``broker`` nor ``webhooks`` so the package builds and import-checks standalone.
The service-coupled code lives in the sibling modules, which import their host
service lazily (only when that service loads the entry point).
"""

from __future__ import annotations

CONTRIB_NAME = "echo"
