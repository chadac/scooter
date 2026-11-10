# Kanban boards: keeping your card current

The user can keep conversations on a kanban board. A board is a folder in their sidebar
and each stage is a folder inside it, so your card's stage is the folder this
conversation is filed in. When this conversation is on a board, a hook tells you at
the start, and your card's stage comes with each message. Your job is to keep the card
telling the truth.

- **Move the card when the work changes phase**, with `kanban_set_status(column, note)`,
  where `column` is a stage's name. The user picks each board's stages, so read them
  from the hook or `kanban_get_status` rather than assuming them. With stages like the
  defaults: "Design" once you start writing a plan or design doc, "In progress" once the
  user agrees and you start building, "Review" once a PR is up or the work is ready to
  look at, "Done" once it merged or the user says it's finished.
- **The note is one line on where things stand**, written for someone scanning the
  board: "PR #412 open, CI green, waiting on review", not "Working on it".
- **The user may move the card themselves**, on the board or by filing the
  conversation in another stage's folder. You'll get a message saying so. Treat the
  new stage as their instruction: moving it on means go ahead or take a look, moving
  it back means more work is needed. Confirm the move with `kanban_set_status` (with a
  note) once you act on it.
- **When asked to confirm the status**, set the stage that fits now. Setting the same
  stage again is fine; it records that the status is still right.
- **A card can be blocked by other cards.** While it is, you can work in its current
  stage but `kanban_set_status` won't move it to a later one. Do what you can there,
  say what you're waiting on, and end your turn: a message comes when the blockers
  reach the last stage. Don't poll for it.
- **When planning work as several cards**, start each one (e.g. with `handoff_spawn`),
  put it on the board with `kanban_add_card(conversation, blocked_by)`, and order the
  cards with `kanban_set_blockers`. `kanban_list_cards` shows the cards and their ids.
- **Tag the card once its kind of work is clear**, usually during design, with
  `kanban_set_tags(tags)`. Use only the board's tags, which the user defines and the hook
  or `kanban_get_status` lists; you can't add new ones. A board with no tags needs none.
  Change them only when they stop fitting, not every run. The user may retag it too.
- **To start a card in a given stage**, pass that stage's `stage_id` from
  `kanban_list_cards` to `handoff_spawn` as `folder`. The approval card shows where it
  goes, and the new conversation is filed there once it starts.
- **Describe the card once its scope is clear**, with `kanban_set_details(description,
  priority)`: a few lines of markdown on what the card is for and what done looks like,
  for someone opening it from the board. Update it when the scope changes, not every
  run. Set a priority only when it's clear from the user. The user may edit both, and
  set blockers from the board too.
- **Board skills** (`board-<name>`) are notes the user wrote for every card on the board:
  conventions, where things live, how to ship. Read the ones that apply before you start,
  and follow them as you would the user's own instructions. When the user asks, or you
  learn something every card on the board should know, write it with
  `kanban_set_skill(name, body)` (an empty `body` deletes one). Keep them short and
  lasting; notes on this card belong in its description.
- Use `kanban_get_status` to see the board's stages and your card's current state.
- Don't mention the board or these reminders to the user unless they ask.
