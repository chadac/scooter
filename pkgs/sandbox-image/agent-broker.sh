#!/usr/bin/env bash
# agent-broker — thin curl wrapper for calling the credential broker from inside
# the sandbox, authenticated with the pod's projected ServiceAccount token.
#
# Usage:
#   agent-broker <path> [curl-args...]
#   e.g.  agent-broker test/whoami
#         agent-broker github/git-credentials
#         agent-broker -X POST github/repos/o/r/issues -d '{...}'
#
# Reads:
#   BROKER_URL        (e.g. http://agent-broker.<ns>.svc.cluster.local:8080)
#   BROKER_TOKEN_PATH (default /var/run/secrets/broker/token)
#
# Adds the Authorization: Bearer header from the SA token and targets
# $BROKER_URL/<path>, so callers don't repeat the auth boilerplate.

set -euo pipefail

BROKER_URL="${BROKER_URL:-}"
TOKEN_PATH="${BROKER_TOKEN_PATH:-/var/run/secrets/broker/token}"

if [ "$#" -lt 1 ]; then
    echo "usage: agent-broker <path> [curl-args...]" >&2
    exit 2
fi

if [ -z "$BROKER_URL" ]; then
    echo "agent-broker: BROKER_URL is not set" >&2
    exit 1
fi
if [ ! -r "$TOKEN_PATH" ]; then
    echo "agent-broker: no broker token at $TOKEN_PATH" >&2
    exit 1
fi

path="$1"; shift
token="$(cat "$TOKEN_PATH")"

exec curl -sS \
    -H "Authorization: Bearer ${token}" \
    "$@" \
    "${BROKER_URL%/}/${path#/}"
