"""Jira integration for Scooter, as a contrib module.

Everything Jira-specific lives here: the broker provider and its Atlassian OAuth
credential source, the webhooks handler and its comment responses, and the URL
shapes that say `https://acme.atlassian.net/browse/ENG-42` and `ENG-42` are the
same issue. Nothing imports the broker or webhooks app.
"""

CONTRIB_NAME = "jira"
