# Once per run, in a board folder: ask for a status when the card is unset or stale.
in=$(cat)
printf '%s' "$in" | jq -e '.stop_hook_active' >/dev/null && exit 0
folder=$(printf '%s' "$in" | jq -r '.scooter.folder.id // empty')
card=$(agent-broker "kanban/card?folder=$folder" -f) || exit 0
printf '%s' "$card" | jq -e '.board and .stale' >/dev/null || exit 0
echo "This conversation is a card on a kanban board and its status is unset or out of date. Call kanban_set_status with the column that fits the work now (the same column confirms it) and a one-line note, then end your turn. Do not mention this to the user." >&2
exit 2
