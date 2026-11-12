# Integrations

## Webhooks

GitHub, GitLab, and Slack events spawn or address conversations: an issue comment or a Slack
mention becomes a prompt, attributed to the mapped Scooter user. Provider routes verify
signatures; the webhook service resolves the external identity to an internal owner.

## Scheduled runs

Cron-style scheduled tasks prompt a conversation on a timer — recurring reports, monitors,
maintenance. Scheduled runs never consume a user's personal bring-your-own subscription; they
run on the platform's floor model.

## The broker

A per-conversation **permissions broker** vends scoped credentials into the sandbox — git
credentials, cloud (AWS) access — with a policy and audit layer between the agent and anything
sensitive. Third-party providers plug in as Python modules behind core-enforced middleware.

## Contrib modules

Integrations are **discovered, not hardcoded**. Both the broker and the webhooks service scan
an entry-point group at startup (`agent_broker.providers` / `scooter_webhooks.handlers`) and
mount whatever registered factories they find, alongside the in-tree built-ins. A new
integration is a self-contained package under `contrib/<name>/` — a broker provider, a
webhooks handler, or both — that plugs in without editing any service's core. See
`contrib/README.md` for the layout — one file per half: `contrib.nix` (what it is),
`deployment.nix` (its kubenix options), `sandbox.nix` (its half of the agent image).
The direction of travel is
entry-point-first: every integration eventually ships as a contrib package, with the in-tree
scan retained only for development.

## Web services from the sandbox

Long-running services the agent starts in its sandbox (a dev server, a notebook, a terminal)
are proxied out through the platform with per-conversation URLs, and survive suspend/resume:
enabled services restart when the sandbox wakes.

By default they're served under `https://<host>/c/<conversation-id>/<service>/`, on the
same origin as the Scooter UI. Setting `scooter.ingress.sandboxDomain` gives each
conversation its own origin instead, `https://<label>.<sandboxDomain>/<service>/` (the
label is the first 8 characters of the conversation id), so a page a sandbox serves can't
script the Scooter UI or another conversation's services. That needs a wildcard DNS record
and certificate for `*.<sandboxDomain>`, authenticated by the ingress like the main host.
Sandboxes created before the setting changes keep their old URLs until they're recreated.

## MCP servers from Settings

With the `mcpservers` contrib enabled, Settings → **MCP servers** lists servers to start
in every sandbox you own: an **npm** package (run with `npx -y`), a **PyPI** package (run
with `uv tool run`) or a **nixpkgs** attribute (run with `nix run`), each with optional
arguments. The agent gets a server's tools as `sandbox-<name>` once it's running. A change
reaches running sandboxes within a couple of minutes. There's no way to give these servers
an API key yet, and anything in their arguments is readable by the agent.

## Kanban boards

With the `kanban` contrib enabled, `/boards` shows a folder as a board, with its
conversations as cards in stage columns. Each stage is a locked folder inside the board,
so moving a card files its conversation in another folder. The agent moves its own card as
the work changes phase, and can add cards to the board for the work it hands off. A card
can't move on until every card blocking it reaches the last stage. Under **Edit board**,
the user can write a board's skills: short notes, such as conventions or release steps,
that every agent on the board gets as a skill named `board-<name>`. Agents can write
and update them too, when asked or when they learn something the whole board should
know.

Edit board also sets the board's **gates**: checks a card must pass as its agent moves it
on. **Add gate** adds one; each then says which stage it is on, whether it applies to
**leave** that stage or to **enter** it, and what it checks. A move that jumps over stages owes
the gates of every stage it leaves and enters; a move back owes none. A **prompt** gate
asks the agent to do something, in your words ("run the tests on a clean checkout of your
last commit; pass if they do") or by following one of the board's skills, and to answer
whether it passed, with a note you see on the card. `kanban_set_status` refuses the move
until every prompt gate has passed. An **approval** gate asks you once the prompts pass: the
card shows **Approve**, and its Details tab has Approve and Reject with a comment the
agent receives. Moving a card past a gate uses up the pass, so a card that comes back
to the stage has to pass again. Your own moves aren't gated. When you move a card past a
prompt gate, the board first offers to **Ask the agent**: the card's agent is asked to make
the move itself, so its gates apply as for its own moves, and the card moves once they pass. If
one fails, the agent says why in the chat. **Move anyway** moves it now without them, and counts
as the approval for that stage.

**For you**, in the board's header, filters the lanes to the cards waiting on you: an approval
gate an agent has asked you for, an agent waiting on an answer to a question, or a pull or
merge request linked to a card that hasn't reached the last stage. Its count says how many
cards that is. Under the filter each card says what it waits on, a PR links out to the PR, and a
card waiting on an approval opens on its Details tab. The board remembers the filter.

Setup is in [Setting up contribs](../tutorial/contribs.md#kanban-boards).
