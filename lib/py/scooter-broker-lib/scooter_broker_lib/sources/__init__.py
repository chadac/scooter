"""Credential sources — how a provider obtains its secret.

Each implements the `CredentialSource` protocol from `..types`: static PAT,
GitHub App installation token, Atlassian OAuth refresh, Datadog's key pair.
A provider picks one (or brings its own).
"""
