#!/usr/bin/env bash
# Generic sandbox entrypoint.
#
# There is NO in-pod server. Commands reach the sandbox via the Kubernetes exec
# API (the agent-host's ExecBackend), like upstream examples/sandboxed-tools.
# The entrypoint's only jobs:
#   1. setup_overlay_store — make /nix/store writable via overlayfs
#      (read-only image lower + writable upper; tmpfs-copy fallback unprivileged)
#   2. stay alive so the controller sees a Running pod and exec can attach.
#
# Packages are installed on demand by the commands the agent-host execs
# (`nix profile install ...`, taught by the nix-packages skill).

set -euo pipefail

setup_overlay_store() { :; }   # TODO (impl)

main() {
  setup_overlay_store
  # Keep PID 1 alive; the pod is driven entirely via `kubectl exec`.
  exec sleep infinity
}

main "$@"
