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
#   agent-broker link add <url> [--type pr|mr|issue] [--source github|gitlab|jira] [--title T]
#   agent-broker link ls
#     Attach a link (PR/MR/issue/etc.) to THIS conversation, or list the ones
#     already attached. PRs/MRs/issues created *through* the broker proxy are
#     auto-linked; use `link add` for anything the injector missed (e.g. created
#     via the gh/glab CLI). The conversation is taken from the pod's SA token.
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

usage() {
    cat >&2 <<'EOF'
usage:
  agent-broker <path> [curl-args...]
  agent-broker link add <url> [--type pr|mr|issue] [--source github|gitlab|jira] [--title TITLE]
  agent-broker link ls
EOF
}

if [ "$#" -lt 1 ]; then
    usage
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

token="$(cat "$TOKEN_PATH")"

# call <method> <path> [curl-args...] — curl to BROKER_URL/<path> with auth.
call() {
    local method="$1" path="$2"; shift 2
    curl -sS -X "$method" \
        -H "Authorization: Bearer ${token}" \
        "$@" \
        "${BROKER_URL%/}/${path#/}"
}

# infer_source <url> — best-effort default for --source from the URL host.
infer_source() {
    case "$1" in
        *github.com*|*//github*) echo github ;;
        *gitlab*)                echo gitlab ;;
        *atlassian.net*|*jira*)  echo jira ;;
        *)                       echo "" ;;
    esac
}

# infer_type <url> — best-effort default for --type from the URL shape.
infer_type() {
    case "$1" in
        */pull/*|*/pulls/*)      echo pr ;;
        */merge_requests/*)      echo mr ;;
        */issues/*|*/browse/*)   echo issue ;;
        *)                       echo "" ;;
    esac
}

if [ "$1" = "link" ]; then
    shift
    sub="${1:-}"; shift || true
    case "$sub" in
        ls|list)
            call GET /link | jq -r '
                (.links // []) as $l
                | if ($l | length) == 0 then "no links attached to this conversation"
                  else ($l[] | "- \(.source // "?")/\(.resourceType // .type // "?")  \(.url)\(if .title then "  (\(.title))" else "" end)")
                  end'
            ;;
        add)
            url="${1:-}"; shift || true
            if [ -z "$url" ]; then echo "agent-broker link add: <url> required" >&2; exit 2; fi
            type="" ; source="" ; title=""
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --type)   type="${2:-}"; shift 2 ;;
                    --source) source="${2:-}"; shift 2 ;;
                    --title)  title="${2:-}"; shift 2 ;;
                    *) echo "agent-broker link add: unknown arg $1" >&2; exit 2 ;;
                esac
            done
            [ -n "$source" ] || source="$(infer_source "$url")"
            [ -n "$type" ]   || type="$(infer_type "$url")"
            if [ -z "$source" ]; then echo "agent-broker link add: could not infer --source from URL; pass --source" >&2; exit 2; fi
            if [ -z "$type" ];   then echo "agent-broker link add: could not infer --type from URL; pass --type" >&2; exit 2; fi
            body="$(jq -n --arg s "$source" --arg t "$type" --arg u "$url" --arg ti "$title" \
                '{source:$s, resourceType:$t, url:$u} + (if $ti == "" then {} else {title:$ti} end)')"
            call POST /link -H "Content-Type: application/json" -d "$body" >/dev/null
            echo "linked $source/$type -> $url"
            ;;
        ""|-h|--help)
            usage; exit 2 ;;
        *)
            echo "agent-broker link: unknown subcommand '$sub' (want: add | ls)" >&2; exit 2 ;;
    esac
    exit 0
fi

path="$1"; shift
exec curl -sS \
    -H "Authorization: Bearer ${token}" \
    "$@" \
    "${BROKER_URL%/}/${path#/}"
