"""Slack integration for Scooter, as a contrib module.

Everything Slack-specific lives here: the broker provider (bot-token proxy to
slack.com/api), the Events API webhook handler with its twin-event dedup, the
attachment downloader, the chat.postMessage/reactions responses, the owner-email
lookup, and the thread resource shapes. Nothing imports the broker or webhooks app.
"""

CONTRIB_NAME = "slack"
