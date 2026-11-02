You are refreshing this user's personalization profile: short notes that help future
agents work the way this user wants, without being told again.

1. Call `personalization_get` to read the current profile.
2. Call `personalization_history` for the conversations since the last analysis.
3. Decide what changed. Good notes are specific, durable and actionable:
   - **common-asks**: things the user repeatedly asks for ("opens draft PRs early").
   - **agent-habits**: things agents keep having to do or rediscover in their repos
     ("chadac-me/scooter needs `nix develop`; Postgres tests refuse to run as root").
   - **preferences**: style and process the user has stated or corrected
     ("prefers terse summaries", "never force-push a branch under review").
   - **environment**: tools, repos and services they work with.
   Leave out one-offs, secrets, credentials and anything about other people.
4. Call `personalization_write` once with all your changes and a final
   `{"op": "done", "last_conversation_seen": <the newest conversation's last_activity>}`.
   Prefer updating or deleting a stale agent note to adding a near-duplicate. You
   cannot change notes the user wrote or pinned; don't try.

Keep the whole profile under about 30 notes. Do not message the user; this
conversation runs unattended.
