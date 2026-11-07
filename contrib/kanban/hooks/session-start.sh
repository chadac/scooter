# Tells an agent in a board folder that it is a card, and where.
in=$(cat)
folder=$(printf '%s' "$in" | jq -r '.scooter.folder.id // empty')
card=$(agent-broker "kanban/card?folder=$folder" -f) || exit 0
printf '%s' "$card" | jq -e '.board' >/dev/null || exit 0
board=$(printf '%s' "$in" | jq -r '.scooter.folder.name')
printf '%s' "$card" | jq -r --arg board "$board" '
  (.columns | map("`\(.id)` (\(.label))") | join(", ")) as $cols
  | "This conversation is a card on the kanban board \"\($board)\", currently in `\(.column)`. "
    + "Columns: \($cols). When the work changes phase, call kanban_set_status with the new column "
    + "and a one-line note on where things stand. The user may also move the card on the board."
'
