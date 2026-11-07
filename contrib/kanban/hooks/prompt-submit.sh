# Reminds an agent in a board folder of its column, so a move made on the board is seen.
folder=$(jq -r '.scooter.folder.id // empty')
card=$(agent-broker "kanban/card?folder=$folder" -f) || exit 0
printf '%s' "$card" | jq -e '.board' >/dev/null || exit 0
printf '%s' "$card" | jq -r '"Kanban: this card is in `\(.column)`" + (if .card.updated_by == "user" then " (moved there by the user)." else "." end)'
