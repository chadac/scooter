#!/usr/bin/env bash
# Generic sandbox entrypoint.
# Design stage: outline only (lifted from openhands-nix; trimmed to the body).
#
# 1. setup_overlay_store   — make /nix/store writable via overlayfs
#                            (read-only image lower + writable upper;
#                             tmpfs-copy fallback for unprivileged pods)
# 2. start the runtime server implementing the agent-sandbox contract on :8888
#
# NOTE: no agent and no background `nix profile install` of a task env here —
# the agent runs outside; packages are installed on demand by the commands the
# agent-host sends via /execute (taught by the nix-packages skill).

set -euo pipefail

setup_overlay_store() { :; }   # TODO (impl)

main() {
  setup_overlay_store
  exec agent-sandbox-runtime-server --port "${PORT:-8888}"
}

main "$@"
