# Tells the agent its card's stage; marks when the run started.
in=$(cat)
folder=$(printf '%s' "$in" | jq -r '.scooter.folder.id // empty')
run=$(printf '%s' "$in" | jq -r '.scooter.run_id // empty')
card=$(agent-broker "kanban/card?folder=$folder" -f) || exit 0
printf '%s' "$card" | jq -e '.board' >/dev/null || exit 0
if [ -n "$run" ]; then
  # stop.sh asks for a status unless the agent set one after this time.
  dir=${XDG_RUNTIME_DIR:-/tmp}/scooter-kanban
  mkdir -p "$dir" && find "$dir" -type f -mmin +1440 -delete 2>/dev/null
  [ -e "$dir/$run" ] || printf '%s' "$card" | jq -r '.now // empty' >"$dir/$run"
fi
printf '%s' "$card" | jq -r '
  "Kanban: this card is in \"\(.column)\""
  + if .card == null then ", but no status has been set yet."
    elif .card.updated_by == "user" then " (moved there by the user)."
    else "." end
  + if (.card.note // "") != "" then " Note: \(.card.note | @json)." else "" end
  + if (.blocked_by // []) != [] then
      " Blocked by " + (.blocked_by | map("\(.title | @json) (\(.stage))") | join(", "))
      + ": you can work in this stage, but can'\''t move the card to a later one until they reach \"\(.columns[-1])\"."
    else "" end'
