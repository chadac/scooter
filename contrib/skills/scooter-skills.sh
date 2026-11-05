# scooter-skills: the sandbox's own skills under ~/.scooter/skills.
set -euo pipefail

SKILLS="$HOME/.scooter/skills"
# Records what `sync` installed, so hand-written skills are never touched.
MANAGED="$SKILLS/.managed.json"
SOURCES="$HOME/.scooter/skill-sources.json"
# The agent-host's per-skill cap; larger files are skipped here.
MAX_BYTES=32768
# Wait this long before retrying sources that failed.
RETRY_SECS=600
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

usage() {
  cat >&2 <<'EOF'
scooter-skills — skills that live in this sandbox.

  scooter-skills list            list the skills under ~/.scooter/skills
  scooter-skills dump            print them as JSON
  scooter-skills status          show what the last sync installed, and any errors
  scooter-skills sync [--force]  install the skill sources from Settings
  scooter-skills provide         sync, then dump (the agent-host's skill provider)

Write a skill by hand as ~/.scooter/skills/<name>/SKILL.md; the agent picks it up on
its next message. `sync` only replaces the skills it installed itself.
EOF
}

# Skill directories, one per line, minus dot-dirs and bad names.
skill_dirs() {
  [ -d "$SKILLS" ] || return 0
  find "$SKILLS" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) ! -name '.*' -print | sort | while read -r d; do
    n=$(basename "$d")
    [[ "$n" =~ $NAME_RE ]] || continue
    [ -f "$d/SKILL.md" ] && printf '%s\n' "$d"
  done
}

# `description:` from a SKILL.md frontmatter, or empty.
description_of() {
  # A `>`/`|` block scalar continues on the indented lines below.
  awk 'NR==1 && $0!="---" {exit}
       NR>1 && $0=="---" {exit}
       block && /^[ \t]/ {sub(/^[ \t]+/, ""); out = out (out == "" ? "" : " ") $0; next}
       block {exit}
       NR>1 && /^description:/ {
         sub(/^description:[ \t]*/, "")
         if ($0 ~ /^[>|][-+]?$/) {block = 1; next}
         gsub(/^["\047]|["\047]$/, ""); out = $0; exit
       }
       END {print out}' "$1"
}

cmd_list() {
  skill_dirs | while read -r d; do
    printf '%-32s %s\n' "$(basename "$d")" "$(description_of "$d/SKILL.md" | cut -c1-100)"
  done
}

cmd_dump() {
  skill_dirs | while read -r d; do
    f="$d/SKILL.md"
    if [ "$(stat -L -c %s "$f")" -gt "$MAX_BYTES" ]; then
      echo "scooter-skills: skipping $(basename "$d"): SKILL.md is over $MAX_BYTES bytes" >&2
      continue
    fi
    jq -n --arg name "$(basename "$d")" --arg dir "$d" --rawfile content "$f" \
      '{name: $name, dir: $dir, content: $content}'
  done | jq -s '{skills: .}'
}

cmd_status() {
  if [ -s "$MANAGED" ]; then jq . "$MANAGED"; else echo "scooter-skills: nothing synced yet" >&2; fi
}

# Stage one source's skill dirs under $2, or fail.
stage_skills_sh() {
  local spec=$1 out=$2 tmp
  tmp=$(mktemp -d)
  # Private HOME, but the real npm cache and git config.
  HOME="$tmp" GIT_CONFIG_GLOBAL="$REAL_HOME/.gitconfig" npm_config_cache="$REAL_HOME/.npm" \
    DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 \
    npx -y "skills@$SKILLS_CLI_VERSION" add "$spec" -g -a claude-code -s '*' -y --copy </dev/null >&2 || { rm -rf "$tmp"; return 1; }
  if [ -d "$tmp/.claude/skills" ]; then
    find "$tmp/.claude/skills" -mindepth 1 -maxdepth 1 -type d -exec cp -r {} "$out/" \;
  fi
  rm -rf "$tmp"
}

stage_github() {
  local spec=$1 out=$2 tmp ref="" path="" owner repo rest
  spec=${spec#https://github.com/}
  spec=${spec%/}
  if [[ "$spec" == *@* ]]; then ref=${spec##*@}; spec=${spec%@*}; fi
  owner=${spec%%/*}; rest=${spec#*/}
  repo=${rest%%/*}; repo=${repo%.git}
  [[ "$rest" == */* ]] && path=${rest#*/}
  tmp=$(mktemp -d)
  git clone -q --depth 1 ${ref:+--branch "$ref"} "https://github.com/$owner/$repo" "$tmp/repo" >&2 || { rm -rf "$tmp"; return 1; }
  local root="$tmp/repo${path:+/$path}"
  [ -d "$root" ] || { echo "scooter-skills: $path is not a directory in $owner/$repo" >&2; rm -rf "$tmp"; return 1; }
  find "$root" -path '*/.git' -prune -o -name SKILL.md -print | while read -r f; do
    local d n
    d=$(dirname "$f")
    # A root SKILL.md is a skill named after its repo.
    if [ "$d" = "$root" ]; then n=$(basename "${path:-$repo}"); else n=$(basename "$d"); fi
    rm -rf "${out:?}/$n"
    cp -r "$d" "$out/$n"
    rm -rf "$out/$n/.git"
  done
  rm -rf "$tmp"
}

# The owner's enabled sources from the broker; on failure the last copy stands.
fetch_sources() {
  local incoming
  if ! incoming=$(agent-broker skills/sources -f 2>/dev/null) \
    || ! printf '%s' "$incoming" | jq -e '.sources | type == "array"' >/dev/null; then
    echo "scooter-skills: could not fetch skill sources; using the last copy" >&2
    return 0
  fi
  printf '%s\n' "$incoming" > "$SOURCES.tmp"
  mv -f "$SOURCES.tmp" "$SOURCES"
}

cmd_sync() {
  local force=0 a
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      *) usage; exit 2 ;;
    esac
  done
  mkdir -p "$SKILLS"
  fetch_sources
  [ -s "$SOURCES" ] || printf '{"sources":[]}\n' > "$SOURCES"

  exec 9>"$SKILLS/.sync.lock"
  flock 9

  hash=$(sha256sum "$SOURCES" | cut -d' ' -f1)
  prev='{"hash":"","sources":{}}'
  [ -s "$MANAGED" ] && prev=$(cat "$MANAGED")
  if [ "$force" = 0 ] && [ "$(printf '%s' "$prev" | jq -r '.hash')" = "$hash" ]; then
    echo "scooter-skills: sources unchanged"
    return 0
  fi
  if [ "$force" = 0 ] && [ "$(printf '%s' "$prev" | jq -r '.failedHash // ""')" = "$hash" ] \
    && [ $(($(date +%s) - $(printf '%s' "$prev" | jq -r '.failedAt // 0'))) -lt "$RETRY_SECS" ]; then
    echo "scooter-skills: a source failed recently; retrying later (sync --force to retry now)"
    return 0
  fi

  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  next='{}'
  failed=0
  count=$(jq '.sources | length' "$SOURCES")
  for ((i = 0; i < count; i++)); do
    src=$(jq -c ".sources[$i]" "$SOURCES")
    kind=$(jq -r '.kind' <<<"$src")
    spec=$(jq -r '.spec' <<<"$src")
    key="$kind:$spec"
    out="$stage/$i"
    mkdir -p "$out"
    err=""
    case "$kind" in
      skills.sh) stage_skills_sh "$spec" "$out" 2>"$stage/$i.err" || err=$(tail -c 2000 "$stage/$i.err") ;;
      github) stage_github "$spec" "$out" 2>"$stage/$i.err" || err=$(tail -c 2000 "$stage/$i.err") ;;
      *) err="unknown source kind '$kind'" ;;
    esac
    # Only the named skills, when the source lists any.
    if [ -z "$err" ] && [ "$(jq '.skills // [] | length' <<<"$src")" -gt 0 ]; then
      for d in "$out"/*/; do
        n=$(basename "$d")
        jq -e --arg n "$n" '.skills | index($n)' <<<"$src" >/dev/null || rm -rf "$d"
      done
    fi
    if [ -n "$err" ]; then
      failed=1
      echo "scooter-skills: $key failed: $err" >&2
      # A failed fetch keeps that source's previous install.
      kept=$(printf '%s' "$prev" | jq -c --arg k "$key" '.sources[$k].skills // []')
      next=$(jq -c --arg k "$key" --argjson s "$kept" --arg e "$err" '.[$k] = {skills: $s, error: $e}' <<<"$next")
      continue
    fi
    names=$(find "$out" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | jq -R . | jq -sc .)
    next=$(jq -c --arg k "$key" --argjson s "$names" '.[$k] = {skills: $s}' <<<"$next")
  done

  # Retire the last sync's skills, except a failed source's.
  owned=$(printf '%s' "$prev" | jq -c '[.sources[]?.skills[]?] | unique')
  keep=$(jq -c '[.[] | select(.error) | .skills[]] | unique' <<<"$next")
  jq -r --argjson k "$keep" '. - $k | .[]' <<<"$owned" | while read -r n; do
    if [[ "$n" =~ $NAME_RE ]]; then rm -rf "${SKILLS:?}/$n"; fi
  done
  installed=0
  for ((i = 0; i < count; i++)); do
    [ -d "$stage/$i" ] || continue
    for d in "$stage/$i"/*/; do
      [ -d "$d" ] || continue
      n=$(basename "$d")
      [[ "$n" =~ $NAME_RE ]] || { echo "scooter-skills: skipping '$n': not a valid skill name" >&2; continue; }
      # A hand-written skill of the same name wins.
      if [ -e "$SKILLS/$n" ] && ! jq -e --arg n "$n" 'index($n)' <<<"$owned" >/dev/null; then
        echo "scooter-skills: skipping '$n': ~/.scooter/skills/$n is yours, not from a source" >&2
        next=$(jq -c --arg n "$n" 'with_entries(.value.skills -= [$n])' <<<"$next")
        continue
      fi
      rm -rf "${SKILLS:?}/$n"
      cp -r "$d" "$SKILLS/$n"
      installed=$((installed + 1))
    done
  done

  # A failure leaves the hash unset, so a later sync retries.
  stamp=$hash failedHash=""
  [ "$failed" = 1 ] && stamp="" failedHash=$hash
  jq -n --arg h "$stamp" --arg fh "$failedHash" --argjson fa "$(date +%s)" --argjson s "$next" \
    --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{hash: $h, failedHash: $fh, failedAt: $fa, syncedAt: $t, sources: $s}' > "$MANAGED.tmp"
  mv -f "$MANAGED.tmp" "$MANAGED"
  echo "scooter-skills: installed $installed skill(s) from $count source(s)"
  [ "$failed" = 0 ]
}

# A failed sync still offers what is installed.
cmd_provide() {
  cat >/dev/null
  "$0" sync >&2 || echo "scooter-skills: sync failed; offering installed skills" >&2
  cmd_dump
}

REAL_HOME=$HOME
case "${1:-}" in
  list | "") cmd_list ;;
  dump) cmd_dump ;;
  provide) cmd_provide ;;
  status) cmd_status ;;
  sync) shift; cmd_sync "$@" ;;
  -h | --help | help) usage ;;
  *) usage; exit 2 ;;
esac
