#!/usr/bin/env bash
# Fast local harness for scooter-apply-module's CONTROL FLOW, with mocked
# nix-env/systemctl/systemd-run/nix. Validates: good apply registers a gen +
# exits 0; bad apply (new failed unit) rolls back + exits 1. No VM.
set -uo pipefail

MOCK=/tmp/apply-mock; rm -rf "$MOCK"; mkdir -p "$MOCK/bin"
export PATH="$MOCK/bin:$PATH"
STATE=/tmp/apply-state; rm -rf "$STATE"; mkdir -p "$STATE"
: > "$STATE/failed_units"        # space/newline-separated failed unit names
echo 1 > "$STATE/gen"            # current generation number
echo "/nix/store/gen1-system" > "$STATE/profile"  # what system profile points at

cat > "$MOCK/bin/nix" <<'EOF'
#!/usr/bin/env bash
# `nix build ... --expr ...` -> print a fake toplevel out path
echo "/nix/store/genX-system"
EOF

cat > "$MOCK/bin/nix-env" <<'EOF'
#!/usr/bin/env bash
S=/tmp/apply-state
args="$*"
if [[ "$args" == *"--set"* ]]; then
  # last arg is the toplevel
  for a in "$@"; do tl="$a"; done
  echo "$tl" > "$S/profile"
  g=$(( $(cat "$S/gen") + 1 )); echo "$g" > "$S/gen"
  echo "nix-env: set gen $g -> $tl" >&2
elif [[ "$args" == *"--rollback"* ]]; then
  g=$(( $(cat "$S/gen") - 1 )); echo "$g" > "$S/gen"
  echo "/nix/store/gen$g-system" > "$S/profile"
  echo "nix-env: rolled back to gen $g" >&2
fi
EOF

cat > "$MOCK/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
# Ignore the scope flags; just run the wrapped command ("$toplevel/bin/switch...").
# Find the command after the last --unit=... arg.
shift_to_cmd() { while [ $# -gt 0 ]; do case "$1" in --*|"") shift;; *) break;; esac; done; "$@"; }
# The real invocation is: systemd-run --scope --collect --quiet --unit=... <prog> switch
# Strip flags + --unit, then run the program.
cmd=(); seen=0
for a in "$@"; do
  case "$a" in --scope|--collect|--quiet|--wait) ;; --unit=*) ;; *) cmd+=("$a");; esac
done
"${cmd[@]}"
EOF

# A fake switch-to-configuration that SUCCEEDS (good) or marks a unit failed (bad).
mkdir -p "$STATE/good/bin" "$STATE/bad/bin"
cat > "$STATE/good/bin/switch-to-configuration" <<'EOF'
#!/usr/bin/env bash
echo "switch(good): activated" >&2; exit 0
EOF
cat > "$STATE/bad/bin/switch-to-configuration" <<'EOF'
#!/usr/bin/env bash
# Simulate a unit that fails during the switch.
echo "scooter-bad.service" >> /tmp/apply-state/failed_units
echo "switch(bad): a unit failed" >&2; exit 1
EOF
chmod +x "$STATE"/{good,bad}/bin/switch-to-configuration

cat > "$MOCK/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
S=/tmp/apply-state
case "$*" in
  *"list-units --state=failed"*) cat "$S/failed_units" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sed 's/$/ loaded failed failed x/';;
  *"is-active"*) exit 1;;  # scope already gone
  *"is-system-running"*) echo running;;
  *) ;;
esac
EOF
chmod +x "$MOCK"/bin/*

# ---- the control flow under test (mirrors runtime-converge.nix) ----
run_apply() {  # $1 = good|bad
  local kind="$1"
  local systemProfile="$STATE/profile_link"   # we mock readlink via the file
  set -euo pipefail
  failed_before=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)
  toplevel=$(nix build)
  prev=$(cat "$STATE/profile")
  nix-env -p x --set "$toplevel"
  # switch via the kind-specific fake
  systemd-run --scope --collect --quiet --unit=sw "$STATE/$kind/bin/switch-to-configuration" switch || true
  health_ok=1
  failed_after=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)
  new_failures=$(comm -13 <(printf '%s\n' "$failed_before") <(printf '%s\n' "$failed_after") || true)
  if [ -n "$new_failures" ]; then echo "NEW FAILED: $new_failures" >&2; health_ok=0; fi
  if [ "$health_ok" -ne 1 ]; then
    echo "APPLY FAILED -> rollback" >&2
    nix-env -p x --rollback || true
    return 1
  fi
  echo "APPLY OK"
  return 0
}

echo "=== GOOD apply ==="
( run_apply good ) && echo "exit=0 (good) ✓" || echo "exit=$? (UNEXPECTED for good) ✗"
echo "gen after good: $(cat $STATE/gen)  (expect 2)"
echo
echo "=== BAD apply ==="
( run_apply bad ) && echo "exit=0 (UNEXPECTED for bad) ✗" || echo "exit=$? (bad -> rollback) ✓"
echo "gen after bad: $(cat $STATE/gen)  (expect back to 2 after rollback)"
