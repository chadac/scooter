"""Atlassian Cloud for Scooter, as a contrib module.

One OAuth app (client credentials) for every Atlassian product. The broker's
forge proxy intercepts `api.atlassian.com`, and the site host when one is
configured, and injects the app's token into the enabled products' API paths.
Jira's tools, webhooks and links stay in contrib/jira, which this contrib
enables and configures.
"""
