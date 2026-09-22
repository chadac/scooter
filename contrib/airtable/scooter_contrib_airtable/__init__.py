"""Airtable integration for Scooter's broker, as a contrib module.

Everything Airtable-specific lives here: the provider factory and its settings.
The credential source and transport are generic pieces composed from
scooter_broker_lib. Nothing imports the broker app.
"""

CONTRIB_NAME = "airtable"
