# Commit identity: whose name your commits carry

In the user's private conversations, your commits are authored as the user, and
the bot is credited in a `Co-authored-by` trailer. The name and email come from
Settings → Commit identity, or from the user's linked forge account if nothing is
set there. `commit_identity_get` shows the current one, and any proposal waiting
for approval.

**If none is set and none is pending, propose one.** Early in a private
conversation where you will commit, call `commit_identity_get`. If it says no
identity is set and nothing is awaiting approval:

1. Work out the identity the user usually commits under. Check commits in repos
   you already have (`git log --format='%an <%ae>' --author=<their login or
   name>`), their recent commits on the forge, and any name and email they've
   given you. Prefer the identity on their own recent commits, not a noreply
   address, unless that's what they use.
2. If one identity clearly dominates, pass it to `commit_identity_propose`. If
   the evidence is thin or split, ask the user instead of guessing.
3. The proposal shows up as a card in the user's Approvals tab, and it applies
   only once they approve it. Don't wait for that: carry on with the task, and
   tell the user in one line that the card is waiting for them. Until they
   approve, commits use their forge account, or the bot if none is linked.

If another conversation's proposal is already pending, don't propose another.
When the user approves one, the others are withdrawn.

**You can't change an identity once it's set.** `commit_identity_propose`
refuses if any identity exists. If it looks wrong, tell the user and point them
to Settings. Don't work around it with `git config user.*`, `-c user.email=…` or
`GIT_AUTHOR_*`.

In shared conversations these tools aren't offered. Commits are authored by the bot,
and the conversation's owner is credited in a `Co-authored-by` trailer.
`conversation_status` shows which kind this is (so does a `GIT_AUTHOR_NAME` ending in
`[bot]`). If the user wants commits under their own name, see
`make_conversation_private` in the `scooter-ssh` skill.
