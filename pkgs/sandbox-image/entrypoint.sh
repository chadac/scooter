#!/usr/bin/env bash
# Generic sandbox entrypoint.
#
# There is NO in-pod server. Commands reach the sandbox via the Kubernetes exec
# API (the agent-host's ExecBackend), like upstream examples/sandboxed-tools.
# Jobs:
#   1. setup_overlay_store — make /nix/store writable so the agent can
#      `nix profile install` at runtime (overlayfs; tmpfs-copy fallback when
#      unprivileged).
#   2. configure the git credential broker helper (if BROKER_URL is set), so
#      git operations the agent-host execs authenticate via the broker.
#   3. stay alive (PID 1) so the controller sees Running and exec can attach.

set -euo pipefail

setup_overlay_store() {
    if [ -w /nix/store ]; then
        echo "[entrypoint] /nix/store already writable"
        return 0
    fi

    echo "[entrypoint] setting up Nix store overlay..."
    mkdir -p /nix/overlay-upper /nix/overlay-work /nix/overlay-store

    if mount -t overlay overlay \
        -o lowerdir=/nix/store,upperdir=/nix/overlay-upper,workdir=/nix/overlay-work \
        /nix/overlay-store 2>/dev/null; then
        mount --bind /nix/overlay-store /nix/store
        echo "[entrypoint] overlay store mounted"
    else
        echo "[entrypoint] WARNING: overlay mount failed (need CAP_SYS_ADMIN);"
        echo "[entrypoint] falling back to tmpfs copy"
        mkdir -p /tmp/nix-store-rw
        cp -a /nix/store/* /tmp/nix-store-rw/ 2>/dev/null || true
        mount --bind /tmp/nix-store-rw /nix/store 2>/dev/null || {
            echo "[entrypoint] WARNING: writable store unavailable; nix installs disabled"
            return 1
        }
    fi
}

configure_git_broker() {
    if [ -n "${BROKER_URL:-}" ]; then
        git config --global credential.helper broker || true
        echo "[entrypoint] git credential helper -> broker ($BROKER_URL)"
    fi
}

configure_aws() {
    # Render ~/.aws/config from the mounted account registry: one
    # [profile <name>] per enabled account, each wired to the credential_process
    # helper. AWS_ACCOUNTS_FILE points at the mounted ConfigMap (accounts.json).
    local accts="${AWS_ACCOUNTS_FILE:-/etc/agent-sandbox/aws/accounts.json}"
    if [ -r "$accts" ] && command -v scooter-aws-credentials >/dev/null 2>&1; then
        mkdir -p "$HOME/.aws"
        if scooter-aws-credentials --render-config "$accts" > "$HOME/.aws/config" 2>/dev/null; then
            echo "[entrypoint] rendered ~/.aws/config from $accts"
        fi
    fi
}

main() {
    setup_overlay_store || true
    configure_git_broker
    configure_aws
    export PATH="$HOME/.nix-profile/bin:$PATH"
    echo "[entrypoint] ready; idling (driven via kubectl exec)"
    # Keep PID 1 alive; the pod is driven entirely via `kubectl exec`.
    exec sleep infinity
}

main "$@"
