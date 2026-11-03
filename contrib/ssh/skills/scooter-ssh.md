# SSH as the user (scooter-ssh)

In the user's private conversations, `ssh`, `scp` and git over ssh://
authenticate with the user's own key. `SSH_AUTH_SOCK` points at an ssh-agent
whose one key is the conversation owner's. The broker holds the private key, so
there is no key file to find and `ssh-add` cannot add one.

- **Private conversations only.** In a shared conversation the agent offers no
  key (`ssh-add -L` prints "The agent has no identities"). That is deliberate:
  anyone can prompt a shared conversation, so it never acts as one person.
  Don't hunt for another credential.
- **Going private.** `conversation_status` says whether this conversation is
  shared or private. When the task needs the owner's key and it is shared, call
  `make_conversation_private`; the key appears within seconds.
  Only the owner can make it shared again, from the UI. If anyone other than
  the owner has prompted this conversation (forwarded comments and messages
  from other people count), or you can't tell, first ask the owner to approve,
  and say why: once private, everything already asked here runs as them.
- **The server must trust the key.** The user's public key is in Settings →
  SSH key. If a host refuses it ("Permission denied (publickey)"), ask the user
  to add that key to the host's `authorized_keys` or to their forge account.
- **Prefer HTTPS for GitHub and GitLab.** Clones over https:// already go
  through the forge proxy. Use ssh:// only when the user asks or HTTPS is not
  an option.
