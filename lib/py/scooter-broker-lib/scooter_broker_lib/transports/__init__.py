"""Transports — how a resolved credential is delivered to the sandbox.

Each implements the `Transport` protocol from `..types` and mounts its own
routes under the provider's prefix: an authenticating HTTP proxy, a
git-credential helper, a raw token vend, a diagnostic whoami.

`aws_permissions` is deliberately NOT here — it pulls the broker app's whole AWS
subsystem, so it is the aws provider's implementation, not reusable surface.
See broker/transports/__init__.py.
"""
