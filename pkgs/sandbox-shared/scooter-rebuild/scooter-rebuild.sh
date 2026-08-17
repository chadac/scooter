# shellcheck shell=bash
# scooter-rebuild switch [--detach] — resolve/build the target toplevel, then switch, with
# generation registration + health-gated auto-rollback.
#
# The at-wrapped vars below (systemProfile, statusDir, configPath, directiveEnv) are replaced by
# default.nix (replaceVars) so this file stays valid shell to edit standalone.
#
# Safety model: a build failure (build branch) exits non-zero BEFORE any profile/switch change
# — the gate. Each good target is registered as a system generation; if the switch then leaves
# NEW failed units, we roll the profile back to the prior generation and re-switch, so a bad
# config can never leave the sandbox stuck broken. Idempotent.
set -euo pipefail

systemProfile="@systemProfile@"
config_path="@configPath@"
status_dir="@statusDir@"
directive="${@directiveEnv@:-}"

# --- arg parse (accept a leading `switch` verb; --detach; pass the REST to the build) --------
# `switch` + `--detach` are handled here. Any OTHER args (e.g. the real config's `--module
# <path>`) are collected into build_args[] and forwarded to scooter_rebuild_build — the injected
# build strategy owns them. --detach re-execs "$0 <build_args>" so the background run sees them too.
detach=0
build_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    switch) shift ;;                       # the CLI verb; module/status are the dispatcher's
    --detach) detach=1; shift ;;
    *) build_args+=("$1"); shift ;;        # forwarded to the build strategy (e.g. --module X)
  esac
done

# --- the caller-injected BUILD STRATEGY (no-directive branch) ---------------
# default.nix replaceVars's the buildCommand var (below) with the caller's build: the bootstrap
# builds the config/root flake; the real config builds via base-config nix build --expr (+ its
# --module / no-op logic). It receives the forwarded args as "$@", MUST set `toplevel` to the
# built store path (and exit non-zero on build failure — the switch gate). It may `write_status
# idle; trap - EXIT; exit 0` for a genuine no-op.
scooter_rebuild_build() {
@buildCommand@
}

# --- status/log protocol (read by scooter-env-status) --------------------
#   $status_dir/status : one word — building | switching | done | failed | idle
#   $status_dir/error  : the failure summary (empty on success)
#   $status_dir/log    : the full combined stdout+stderr of the run
write_status() {
  mkdir -p "$status_dir"
  printf '%s\n' "$1" > "$status_dir/status"
  [ $# -ge 2 ] && printf '%s\n' "$2" > "$status_dir/error" || : > "$status_dir/error"
}

# --- --detach: re-exec THIS run in a SEPARATE systemd unit, then return ---
# The background switch must OUTLIVE its caller. setsid alone is NOT enough: the child stays in
# the CALLER's cgroup — and the boot unit (scooter-firstboot / the real config's apply unit) is
# exactly a unit switch-to-configuration RESTARTS (its own diff includes itself), so systemd
# tears down that cgroup mid-switch and kills the child BEFORE it writes `done`. Run the child as
# its OWN transient unit (systemd-run) so it lives in a separate cgroup, survives the restart,
# and writes its terminal status. --collect reaps it. A switch already in flight is refused.
if [ "$detach" -eq 1 ]; then
  mkdir -p "$status_dir"
  cur=$(cat "$status_dir/status" 2>/dev/null || echo idle)
  if [ "$cur" = "building" ] || [ "$cur" = "switching" ]; then
    echo "scooter-rebuild: a switch is already in progress ($cur) — refusing" >&2
    exit 3
  fi
  write_status building
  # Re-exec the SAME script WITHOUT --detach as a transient unit, forwarding the build_args so the
  # background run sees --module etc. log appended so the caller's `building` line is preserved.
  systemd-run --collect --quiet \
    --unit="scooter-env-switch-$$" \
    --property=StandardOutput="append:$status_dir/log" \
    --property=StandardError="append:$status_dir/log" \
    "$0" "${build_args[@]}"
  echo "scooter-rebuild: applying in the background — poll scooter-env-status"
  exit 0
fi

# The foreground (real) run maintains status too, so a synchronous call (tests / direct) reports
# its phases.
write_status building

# On ANY unexpected exit before the explicit done/failed writes, mark failed so a poller never
# sees a stuck "building" after the process died.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then write_status failed "scooter-rebuild exited $rc"; fi' EXIT

# --- BRANCH: resolve a PREBUILT target, or BUILD the config flake -------------
if [ -n "$directive" ]; then
  case "$directive" in
    http://*|https://*)
      # agent-host directive URL: a gzipped bare store path. curl | gunzip -> the path.
      echo "scooter-rebuild: resolving directive $directive"
      toplevel=$(curl -fsSL "$directive" | gzip -d | head -n1 | tr -d '[:space:]') ;;
    /*)
      # An absolute LOCAL path (the prod happy path: a /nix/store toplevel present in the cloned
      # upper; also accepts a symlink handle like a specialisation link).
      echo "scooter-rebuild: using prebuilt target $directive"
      toplevel="$directive" ;;
    *)
      echo "scooter-rebuild: bad @directiveEnv@ (need an absolute path or URL): $directive" >&2; exit 2 ;;
  esac
  # Canonicalize (a symlink handle -> its store path) and require a VALID toplevel (present +
  # has switch-to-configuration). If the directive is stale/absent, fail loudly not switch junk.
  toplevel=$(readlink -f "$toplevel" 2>/dev/null || echo "$toplevel")
  if [ ! -e "$toplevel/bin/switch-to-configuration" ]; then
    echo "scooter-rebuild: target $toplevel is not a valid system toplevel" >&2
    write_status failed "target $toplevel missing switch-to-configuration"
    exit 1
  fi
else
  # No directive: build the config flake (the real-config re-converge). The flake at config_path
  # pins its own nixpkgs + imports ./custom, so this one build is the whole generation. A build
  # failure exits non-zero HERE (set -e), before any switch — the gate.
  if [ ! -e "$config_path/flake.nix" ]; then
    echo "scooter-rebuild: no directive and no config flake at $config_path — nothing to apply" >&2
    write_status idle
    trap - EXIT
    exit 0
  fi
  echo "scooter-rebuild: building toplevel from $config_path ..."
  # The BUILD STRATEGY is injected by default.nix (the buildCommand var) so one engine serves
  # both callers: the bootstrap builds the config/root FLAKE (path:<config>#sandboxSystem); the
  # real config builds via its base-config nix build --expr. The strategy sets `toplevel`. A
  # build failure exits non-zero HERE (set -e), before any switch — the gate.
  scooter_rebuild_build "${build_args[@]}"   # the injected build function (sets $toplevel)
fi

# --- the invariant switch core -----------------------------------------------
# Remember the CURRENTLY-RUNNING system as the rollback target (NOT the profile link, which
# nix-env --set is about to repoint). Empty on the very first apply.
prev=$(readlink -f /run/current-system 2>/dev/null || readlink -f "$systemProfile" 2>/dev/null || true)

# Snapshot units ALREADY failed before the switch, so we can tell a failure THE SWITCH
# INTRODUCED from pre-existing noise. This is the real rollback signal — NOT
# switch-to-configuration's exit code (unreliable in a container).
failed_before=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)

# Register the built/resolved toplevel as a NEW numbered generation, then switch.
echo "scooter-rebuild: registering generation + switching to $toplevel..."
write_status switching
nix-env -p "$systemProfile" --set "$toplevel"

# Run the switch in a TRANSIENT scope, detached from THIS unit: switch-to-configuration restarts
# the changed-unit diff (which includes the boot unit if we ARE it) and would SIGTERM us
# mid-switch if inline. A --scope process isn't a unit the switch manages, so it survives.
# --scope runs SYNCHRONOUSLY and returns when the switch finishes. The exit code is unreliable in
# a container, so IGNORE it and let the failed-unit diff decide.
systemd-run --scope --collect --quiet \
  --unit="scooter-switch-$$" \
  "$toplevel/bin/switch-to-configuration" switch || true

# Health gate (the AUTHORITATIVE signal): did the switch introduce any NEW failed units?
health_ok=1
failed_after=$(systemctl list-units --state=failed --plain --no-legend 2>/dev/null | awk '{print $1}' | sort || true)
new_failures=$(comm -13 <(printf '%s\n' "$failed_before") <(printf '%s\n' "$failed_after") || true)
if [ -n "$new_failures" ]; then
  echo "scooter-rebuild: switch introduced FAILED units:" >&2
  # shellcheck disable=SC2086
  printf '  %s\n' $new_failures >&2
  health_ok=0
fi

if [ "$health_ok" -ne 1 ]; then
  echo "scooter-rebuild: apply FAILED (new failed units after switch)" >&2
  # shellcheck disable=SC2086
  write_status failed "switch introduced failed units: $(printf '%s ' $new_failures)"
  if [ -n "$prev" ]; then
    echo "scooter-rebuild: ROLLING BACK to $prev..." >&2
    nix-env -p "$systemProfile" --rollback || true
    systemd-run --scope --collect --quiet \
      --unit="scooter-rollback-$$" \
      "$prev/bin/switch-to-configuration" switch || \
      echo "scooter-rebuild: rollback switch ALSO failed — manual intervention needed" >&2
  else
    echo "scooter-rebuild: no prior generation to roll back to" >&2
  fi
  exit 1
fi

echo "scooter-rebuild: applied."
write_status done
trap - EXIT
