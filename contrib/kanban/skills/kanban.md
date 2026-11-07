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
- Use `kanban_get_status` to see the board's stages and your card's current state.
- Don't mention the board or these reminders to the user unless they ask.
