"""Module registry — the broker-side catalog of shareable NixOS modules.

Users/agents publish modules; conversations download + compose them. Files live as a
JSON blob on the shared broker Postgres (no ConfigMaps — see the redesign). Download
is open (Nix isn't a secret); listing is visibility-gated. See
todo/PR_134_MODULE_REGISTRY.md.
"""
