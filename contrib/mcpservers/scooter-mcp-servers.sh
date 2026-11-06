# scooter-mcp-servers: the MCP servers from Settings, run as mcp-user@<name> units.
set -euo pipefail

DIR=/run/scooter/mcp-user
STATUS="$DIR/.status.json"
DECLARED=/run/scooter/mcp-servers.json
RUNTIME=/run/scooter/mcp-servers.runtime.json
NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'

usage() {
  cat >&2 <<'EOF'
scooter-mcp-servers — the MCP servers listed in Settings → MCP servers.

  scooter-mcp-servers list     list them, with their state and port
  scooter-mcp-servers sync     start, restart or stop them to match Settings now
  scooter-mcp-servers run <n>  run one in the foreground (what mcp-user@<n> does)

Each runs as the unit mcp-user@<name>; see `journalctl -u mcp-user@<name>` when one
fails. The sandbox re-syncs every few minutes, so a server stopped by hand comes back
until it is disabled in Settings.
EOF
}

# Units lack the pod's broker env; PID 1 has it.
broker_env() {
  env_of() { tr '\0' '\n' < /proc/1/environ 2>/dev/null | sed -n "s/^$1=//p" | head -1; }
  if [ -z "${BROKER_URL:-}" ]; then BROKER_URL=$(env_of BROKER_URL); export BROKER_URL; fi
  if [ -z "${BROKER_TOKEN_PATH:-}" ]; then
    BROKER_TOKEN_PATH=$(env_of BROKER_TOKEN_PATH)
    if [ -n "$BROKER_TOKEN_PATH" ]; then export BROKER_TOKEN_PATH; else unset BROKER_TOKEN_PATH; fi
  fi
}

record() {  # ERROR (empty on success)
  mkdir -p "$DIR"
  jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg e "$1" '{at: $at, error: (if $e == "" then null else $e end)}' > "$STATUS"
}

# Write stdin to FILE; succeeds only if it changed.
replace_if_changed() {
  tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX")
  cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  mv -f "$tmp" "$1"
}

cmd_sync() {
  broker_env
  mkdir -p "$DIR"
  if ! incoming=$(agent-broker mcpservers/servers -f 2>&1) || ! jq -e '.servers | type == "array"' <<< "$incoming" >/dev/null 2>&1; then
    record "could not read the servers from the broker: $(head -c 300 <<< "$incoming")"
    echo "scooter-mcp-servers: could not read the servers from the broker" >&2
    return 1
  fi

  # A declared server keeps its name and port.
  declared=$(jq -c '[.servers[]? | {name, port}]' "$DECLARED" 2>/dev/null || echo '[]')
  wanted=$(jq -c --arg re "$NAME_RE" --argjson declared "$declared" '
    [.servers[]
     | select((.name | type == "string" and test($re))
              and (.kind | IN("npm", "pypi", "nixpkgs"))
              and (.spec | type == "string" and (startswith("-") | not))
              and ((.args // []) | all(type == "string" and (test("[\n\r]") | not))))
     | select(.name as $n | $declared | all(.name != $n))
     | {name, kind, spec, args: (.args // [])}]
    | unique_by(.name)' <<< "$incoming")

  # Ports in name order, skipping declared servers' ports.
  taken=$(jq -r '.[].port' <<< "$declared")
  port=$PORT_FIRST
  assigned='[]'
  while IFS= read -r srv; do
    [ -n "$srv" ] || continue
    while grep -qx "$port" <<< "$taken" && [ "$port" -le "$PORT_LAST" ]; do port=$((port + 1)); done
    if [ "$port" -gt "$PORT_LAST" ]; then
      echo "scooter-mcp-servers: no free port for $(jq -r .name <<< "$srv")" >&2
      continue
    fi
    assigned=$(jq -c --argjson s "$srv" --argjson p "$port" '. + [$s + {port: $p}]' <<< "$assigned")
    port=$((port + 1))
  done <<< "$(jq -c '.[]' <<< "$wanted")"

  # Safe before starting; only running servers are offered.
  jq '{servers: [.[] | {
        name, displayName: .name, description: "\(.kind) \(.spec)",
        port, path: "/mcp", unit: "mcp-user@\(.name)", autoStart: true}]}' <<< "$assigned" \
    | replace_if_changed "$RUNTIME" || true

  for f in "$DIR"/*.json; do
    [ -e "$f" ] || continue
    n=$(basename "$f" .json)
    if ! jq -e --arg n "$n" 'any(.name == $n)' <<< "$assigned" >/dev/null; then
      systemctl stop "mcp-user@$n" || true
      rm -f "$f"
      echo "stopped $n"
    fi
  done

  rc=0
  while IFS= read -r srv; do
    [ -n "$srv" ] || continue
    n=$(jq -r .name <<< "$srv")
    if jq . <<< "$srv" | replace_if_changed "$DIR/$n.json"; then
      action=restart
    elif systemctl is-active --quiet "mcp-user@$n"; then
      continue
    else
      action=start
    fi
    if systemctl "$action" "mcp-user@$n"; then
      echo "${action}ed $n"
    else
      echo "scooter-mcp-servers: could not $action $n; see journalctl -u mcp-user@$n" >&2
      rc=1
    fi
  done <<< "$(jq -c '.[]' <<< "$assigned")"

  record ""
  return $rc
}

cmd_list() {
  # Printed once, so an early-closing reader can't SIGPIPE.
  out=$(printf '%-20s %-8s %-9s %-5s %s' NAME KIND STATE PORT SPEC)
  for f in "$DIR"/*.json; do
    [ -e "$f" ] || continue
    n=$(basename "$f" .json)
    state=$(systemctl is-active "mcp-user@$n" 2>/dev/null || true)
    IFS=$'\t' read -r a b d e < <(jq -r '[.name, .kind, (.port | tostring), .spec] | @tsv' "$f")
    out="$out"$'\n'"$(printf '%-20s %-8s %-9s %-5s %s' "$a" "$b" "$state" "$d" "$e")"
  done
  if [ -s "$STATUS" ]; then
    out="$out"$'\n'"$(jq -r '"last sync: \(.at)" + (if .error then " — \(.error)" else "" end)' "$STATUS")"
  else
    out="$out"$'\n'"not synced yet"
  fi
  printf '%s\n' "$out" || true
}

cmd_run() {
  n="$1"
  [[ "$n" =~ $NAME_RE ]] || { echo "scooter-mcp-servers: bad name '$n'" >&2; exit 2; }
  f="$DIR/$n.json"
  [ -s "$f" ] || { echo "scooter-mcp-servers: '$n' is not listed in Settings (run: scooter-mcp-servers sync)" >&2; exit 2; }
  kind=$(jq -r .kind "$f")
  spec=$(jq -r .spec "$f")
  port=$(jq -r .port "$f")
  mapfile -t args < <(jq -r '.args[]' "$f")
  case "$kind" in
    npm)     cmd=(npx -y "$spec") ;;
    # uv pins a version only through --from.
    pypi)    cmd=(uv tool run --from "${spec/@/==}" "${spec%%[@=[]*}") ;;
    nixpkgs) cmd=(nix run "nixpkgs#$spec" --) ;;
    *) echo "scooter-mcp-servers: unknown kind '$kind'" >&2; exit 2 ;;
  esac
  exec "$MCP_PROXY" --stateless --host 0.0.0.0 --port "$port" -- "${cmd[@]}" "${args[@]}"
}

case "${1:-}" in
  list|"") cmd_list ;;
  sync) cmd_sync ;;
  run) [ -n "${2:-}" ] || { usage; exit 2; }; cmd_run "$2" ;;
  -h|--help|help) usage ;;
  *) echo "scooter-mcp-servers: unknown command '$1'" >&2; usage; exit 2 ;;
esac
