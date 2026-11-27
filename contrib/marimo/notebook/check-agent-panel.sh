#!/usr/bin/env bash
# Usage: check-agent-panel.sh LAUNCH_PY. $PYTHON must have marimo; defaults to python3.
# Fails when launch.py or agent-panel.js no longer fits this marimo.
set -euo pipefail
launch=$(realpath "$1")
read -r -a python <<<"${PYTHON:-python3}"
port=${PORT:-27181}
base=/c/check/notebook
work=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT
cd "$work"
export HOME=$work/home XDG_CONFIG_HOME=$work/home/.config
mkdir -p "$XDG_CONFIG_HOME/marimo"
printf 'import marimo\napp = marimo.App()\n' > nb.py

fail() { echo "FAIL: $*" >&2; exit 1; }

# Prints the notebook page as marimo serves it through launch.py.
page() {
  SCOOTER_MARIMO_STRICT=1 SCOOTER_MARIMO_HEAD='<script>window.SCOOTER_ACP_PATH="/check/acp";</script>' \
    "${python[@]}" "$launch" edit --headless --no-token --port "$port" --base-url "$base" nb.py >"$work/log" 2>&1 &
  local pid=$!
  for _ in $(seq 120); do
    curl -sf "http://127.0.0.1:$port$base/health" >/dev/null && break
    kill -0 "$pid" 2>/dev/null || { cat "$work/log" >&2; fail "marimo exited before serving"; }
    sleep 0.5
  done
  curl -sf "http://127.0.0.1:$port$base/?file=nb.py" || { cat "$work/log" >&2; fail "no notebook page"; }
  kill "$pid"; wait "$pid" 2>/dev/null || true
  if grep -F 'not patched' "$work/log" >&2; then fail "a launch.py patch did not apply"; fi
}

echo "marimo $("${python[@]}" -c 'import marimo; print(marimo.__version__)')"

out=$(page)
grep -qF 'window.SCOOTER_ACP_PATH="/check/acp"' <<<"$out" || fail "agent-panel head script missing from the page"
grep -qE '"external_agents": *true' <<<"$out" || fail "external_agents is not on by default"

printf '[experimental]\nexternal_agents = false\n' > "$XDG_CONFIG_HOME/marimo/marimo.toml"
out=$(page)
grep -qE '"external_agents": *false' <<<"$out" || fail "the user's external_agents = false was overridden"
rm "$XDG_CONFIG_HOME/marimo/marimo.toml"

# --sandbox relaunches `python -m marimo ...`; launch.py must take its place.
SCOOTER_MARIMO_STRICT=1 "${python[@]}" - "$launch" <<'EOF' || fail "--sandbox relaunch is not rerouted through launch.py"
import importlib.util, os, sys
from marimo._environments import backends
seen = []
backends.launch_server = lambda args, **kw: seen.append(list(args))
spec = importlib.util.spec_from_file_location("launch", sys.argv[1])
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)
launch._patch()
backends.launch_server(["-m", "marimo", "edit"])
assert seen == [[os.path.abspath(sys.argv[1]), "edit"]], seen
EOF

# What agent-panel.js assumes about marimo's frontend bundle and sandbox CLI.
pkg=$("${python[@]}" -c 'import marimo, os; print(os.path.dirname(marimo.__file__))')
for needle in 'claude:{port:3017' '}/message`' 'marimo:acp:sessions:v1' 'marimo:sidebar' \
  'marimo:chrome:ai-panel-tab' 'externalAgentSessionId' 'activeTabId' 'selectedPanel'; do
  grep -qrF -- "$needle" "$pkg/_static/assets" || fail "marimo's frontend no longer has: $needle"
done
grep -qF '["-m", "marimo", *args]' "$pkg/_cli/sandbox.py" || fail "marimo's --sandbox relaunch changed shape"
echo "ok: the Agent panel bridge fits this marimo"
