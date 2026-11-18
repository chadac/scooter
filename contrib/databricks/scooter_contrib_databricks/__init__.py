"""Databricks workspaces for Scooter's broker, one provider per workspace.

Each provider injects a short-lived OAuth access token read from a mounted file
on every request; refreshing the token is the job of whatever updates the Secret.
"""
