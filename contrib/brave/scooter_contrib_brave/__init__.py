"""Brave Search integration for Scooter's broker, as a contrib module.

Everything Brave-specific lives here: the provider factory and its settings.
The credential is a single API key delivered in Brave's own header, so its
source is composed from the shared lib rather than owned here. Nothing imports
the broker app.
"""

CONTRIB_NAME = "brave"
