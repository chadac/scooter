# Tells an agent in a board folder that it is a card, and where.
in=$(cat)
folder=$(printf '%s' "$in" | jq -r '.scooter.folder.id // empty')
card=$(agent-broker "kanban/card?folder=$folder" -f) || exit 0
printf '%s' "$card" | jq -e '.board' >/dev/null || exit 0
printf '%s' "$card" | jq -r '
  (.columns | map("\"\(.)\"") | join(", ")) as $stages
  | "This conversation is a card on a kanban board, currently in the stage \"\(.column)\". "
    + "Stages: \($stages). When the work changes phase, call kanban_set_status with the new stage "
    + "and a one-line note on where things stand. The user may also move the card, or change the stages."
    + if (.blocked_by // []) != [] then
        " It is blocked by " + (.blocked_by | map("\(.title | @json) (\(.stage))") | join(", "))
        + ", so it can'\''t move past this stage until they reach \"\(.columns[-1])\"; you will be messaged when they do."
      else "" end
'
