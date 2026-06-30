#!/usr/bin/env bash
# git-credential-broker — a git credential helper that fetches HTTPS git
# credentials from the credential broker, authenticated with the pod's projected
# ServiceAccount token. The broker mints a short-lived token (e.g. a GitHub App
# installation token) per request, so no long-lived secret ever lives in the
# sandbox.
#
# Wired via `git config --global credential.helper broker` (git resolves the
# bare name "broker" to git-credential-broker on PATH). Git invokes it as:
#     git-credential-broker get   (with key=value lines on stdin)
# and reads back protocol/host/username/password on stdout.
#
# Env (same conventions as agent-broker):
#   BROKER_URL        — e.g. http://agent-broker.<ns>.svc.cluster.local:8080
#   BROKER_TOKEN_PATH — projected SA token (default /var/run/secrets/broker/token)
#
# Host -> broker provider mapping. The broker mounts each provider at
# /{provider}/git-credentials; map the git host to the provider whose source
# vends a usable token for it. Extend GIT_BROKER_HOST_MAP for more forges.

set -euo pipefail

# git calls the helper with an operation arg: get | store | erase.
# We only vend on "get"; store/erase are no-ops (the broker is the source).
op="${1:-}"
[ "$op" = "get" ] || exit 0

# Parse the credential description git sends on stdin (key=value, blank-line end).
host=""
protocol=""
while IFS='=' read -r key value; do
    [ -z "$key" ] && break
    case "$key" in
        host) host="$value" ;;
        protocol) protocol="$value" ;;
    esac
done

# Only handle HTTPS (the broker vends token-based HTTPS creds, not SSH).
[ "$protocol" = "https" ] || exit 0
[ -n "$host" ] || exit 0

BROKER_URL="${BROKER_URL:-}"
TOKEN_PATH="${BROKER_TOKEN_PATH:-/var/run/secrets/broker/token}"
# Defer to other helpers if the broker isn't configured in this pod.
[ -n "$BROKER_URL" ] || exit 0
[ -r "$TOKEN_PATH" ] || exit 0

# Map the git host to a broker provider. Default: github.com -> github.
# Override/extend with GIT_BROKER_HOST_MAP="host1=provider1,host2=provider2".
provider=""
default_map="github.com=github,gitlab.com=gitlab"
IFS=',' read -ra _pairs <<< "${GIT_BROKER_HOST_MAP:-$default_map}"
for pair in "${_pairs[@]}"; do
    h="${pair%%=*}"; p="${pair#*=}"
    if [ "$h" = "$host" ]; then provider="$p"; break; fi
done
# Unknown host -> let git fall through to the next helper.
[ -n "$provider" ] || exit 0

token="$(cat "$TOKEN_PATH")"
resp="$(curl -sf -H "Authorization: Bearer ${token}" \
    "${BROKER_URL%/}/${provider}/git-credentials" 2>/dev/null)" || exit 0

username="$(printf '%s' "$resp" | jq -r '.username // empty' 2>/dev/null)" || exit 0
password="$(printf '%s' "$resp" | jq -r '.password // empty' 2>/dev/null)" || exit 0
[ -n "$username" ] && [ -n "$password" ] || exit 0

# git reads these back; echo the host/protocol it asked for.
printf 'protocol=%s\n' "$protocol"
printf 'host=%s\n' "$host"
printf 'username=%s\n' "$username"
printf 'password=%s\n' "$password"
