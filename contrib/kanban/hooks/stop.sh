# Once per run, in a board folder: ask for a status unless the agent set one this run.
in=$(cat)
printf '%s' "$in" | jq -e '.stop_hook_active' >/dev/null && exit 0
folder=$(printf '%s' "$in" | jq -r '.scooter.folder.id // empty')
run=$(printf '%s' "$in" | jq -r '.scooter.run_id // empty')
since=""
mark=${XDG_RUNTIME_DIR:-/tmp}/scooter-kanban/$run
[ -n "$run" ] && [ -r "$mark" ] && since=$(cat "$mark")
# No mark (no prompt hook this run) falls back to the broker's age check.
query=$(jq -rn --arg f "$folder" --arg s "$since" '"folder=\($f | @uri)" + if $s == "" then "" else "&since=\($s | @uri)" end')
card=$(agent-broker "kanban/card?$query" -f) || exit 0
printf '%s' "$card" | jq -e '.board and .stale' >/dev/null || exit 0
echo "This conversation is a card on a kanban board and its status wasn't set this run. Call kanban_set_status with the column that fits the work now (the same column confirms it) and a one-line note, then end your turn. Do not mention this to the user." >&2
exit 2
