#!/usr/bin/env bash
# Prove that the existing authoring workflow captures function AND trigger edits.
# Work on a private copy; historical migrations and their checksums stay untouched.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "$here/lib/sql/.trigger-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cp -R "$here/lib/sql/agent_host/." "$work/"

python3 - "$work/schema.sql" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
body = "pg_notify('conversations_changed',"
condition = 'OLD."owner"       IS DISTINCT FROM NEW."owner"'
assert body in s and condition in s
p.write_text(s.replace(body, "pg_notify('conversations_changed_probe',")
             .replace(condition, condition + ' OR\n    OLD."phase" IS DISTINCT FROM NEW."phase"'))
PY

"$here/scripts/atlas-dev.sh" migrate diff trigger_probe --env agent_host \
  --dir "file://$work/migrations" --to "file://$work/schema.sql"
# An empty/no-op diff must not pass this test, even if the CLI exits successfully.
files=("$work"/migrations/*_trigger_probe.sql)
test "${#files[@]}" -eq 1 && test -f "${files[0]}"
grep -q 'conversations_changed_probe' "${files[0]}"
grep -q 'conversations_notify_upd' "${files[0]}"
grep -q 'phase' "${files[0]}"

# Replay the generated SQL, then prove that the desired state has been reached.
"$here/scripts/atlas-dev.sh" migrate validate --env agent_host --dir "file://$work/migrations"
"$here/scripts/atlas-dev.sh" migrate diff trigger_repeat --env agent_host \
  --dir "file://$work/migrations" --to "file://$work/schema.sql"
for file in "$work"/migrations/*_trigger_repeat.sql; do
  if [ -f "$file" ]; then
    echo "function/trigger migration did not converge" >&2
    cat "$file" >&2
    exit 1
  fi
done
echo "function and trigger edits generate replayable migrations and converge"
