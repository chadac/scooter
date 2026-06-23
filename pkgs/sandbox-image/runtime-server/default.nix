{ lib, ... }:

# The in-pod runtime server implementing the agent-sandbox contract:
#   POST /execute {command} -> {stdout,stderr,exit_code}
#   POST /upload | GET /download/{p} | GET /list/{p} | GET /exists/{p}
#   GET / (health)
#
# Reference impl: agent-sandbox examples/python-runtime-sandbox/main.py (FastAPI).
# Ours differs only in serving over the Nix-powered environment (overlay store)
# and (optionally) sandboxing exec under /workspace instead of /app.
#
# Design stage: placeholder derivation. At implementation, either:
#   (a) vendor/patch the upstream reference server, or
#   (b) write a small server (any language) honoring the contract.
#
# Provides: bin/agent-sandbox-runtime-server

throw "runtime-server: Design stage — not implemented"
