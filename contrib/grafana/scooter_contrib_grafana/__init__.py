"""Grafana integration for Scooter's broker, as a contrib module.

Everything Grafana-specific lives here: the provider factory and its settings.
The credential is a plain bearer token, so its source is composed from the shared
lib rather than owned here. Nothing imports the broker app.
"""

CONTRIB_NAME = "grafana"
