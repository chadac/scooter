---
name: scooter-design-review
type: knowledge
version: 1.1.0
triggers:
- design
- design doc
- design this
- let's design
- architecture
- propose
- proposal
- rfc
- spec
- plan out
- how should we
- trade-offs
- tradeoffs
- options for
- adr
- write up a plan
---

# Designing with the user: write a doc, send a link (scooter-design-review)

When the user asks you to design something (a feature, an architecture, a
migration, an API, or a choice between approaches), **don't design in chat**.
Write the design as a markdown file in the workspace and send the user a link to
it in the files viewer. They read it rendered, comment on specific lines, and
answer your open questions in the page itself. Each comment or answer wakes you
with its file, line and text, so you can revise the doc and reply.

This is the default for design work. Do it without being asked.

## 1. Write the doc

Put it beside the code it concerns (for example `docs/design/<topic>.md` in the
repo, or `/workspace/designs/<topic>.md` if there is no repo yet). Keep it short
and scannable, since the user reads and comments line by line:

- **Problem**: what is wrong or missing, in a few sentences.
- **Proposal**: what you would do, concretely enough to be argued with.
- **Alternatives**: each with why it lost.
- **Open questions**: as question fields (below), not as prose.

Leave out anything you can decide yourself. Each open question should be one
only the user can answer.

## 2. Ask decisions as question fields

A question field is an HTML comment block, so the doc still renders as plain
markdown anywhere, GitHub included. The viewer renders it as a form:

```markdown
<!-- scooter:question id="retry-policy" kind="single" -->
How should the outbox treat a rolling deploy?

- [ ] Keep five fixed attempts and let the reader press retry
- [ ] Grow the backoff until the deploy finishes
<!-- /scooter:question -->
```

- `id` is required and must be unique in the doc. Answers are stored against it,
  so don't rename it once the user may have answered.
- `kind` is `single` (pick one; the default), `multi` (pick any) or `text`
  (free answer; list items are just prose).
- Put your recommendation first and say why in the prompt.
- Blocks inside code fences are examples, not fields, like the one above.

## 3. Send the link

```bash
FILES=$(scooter-service start files | sed -n 's/^url: //p')
# A path (/c/<id>/files/) means the main host: prefix the origin of $CONVERSATION_URL.
case "$FILES" in /*) FILES="$(echo "$CONVERSATION_URL" | sed -E 's#^(https?://[^/]+).*#\1#')$FILES" ;; esac
echo "${FILES}?path=docs/design/retry.md"
```

`path` is relative to `/workspace`. Add a heading anchor (`#open-questions`) to
land the user on a section. In chat, write a short summary: the proposal in a
sentence or two, plus how many questions are open. Then end your turn. Don't
wait or poll, since their remarks will wake you.

## 4. When a remark wakes you

The message names each remark's file, line, quoted text and comment, and for an
answer the question `id`. To see a whole doc's state:

```bash
# In-pod: /files on its own origin, /c/<id>/files on the main host.
V="http://127.0.0.1:7801$([ -n "${SCOOTER_SERVICES_ORIGIN:-}" ] || echo "/c/$CONVERSATION_ID")/files"
curl -s "$V/api/annotations?path=docs/design/retry.md" | jq '.annotations[] | {id, line, kind, thread, resolved, question_id, text}'
curl -s "$V/api/questions?path=docs/design/retry.md"   | jq '.questions[] | {id, answered, answers: [.answers[].text]}'
```

Then:

- **Write the decision into the doc.** The file is the source of truth. Once a
  question is answered, replace its block with the decision and its reason.
  The answer stays on record.
- **Act on comments** by editing the doc.
- **Reply in the thread** so the answer sits beside the line it is about, then
  **resolve it** if that settles it, so the doc's open count stays honest. Each
  comment in the wake message ends with the exact commands:

  ```bash
  scooter-files reply <thread> "Agreed, switched to exponential backoff." --resolve
  scooter-files resolve <thread>            # --reopen to undo
  ```

  The reply shows as "Scooter", sits at the thread's line even after you edit
  the quoted text, and does not wake you. Keep it short: what you changed, or
  why you didn't. Use chat for a summary of what changed, with the link again.

Start implementing once the open questions are answered and the user agrees.
If the user wants to skip the doc ("just do it"), do that instead.

## If the viewer can't wake you

If `SCOOTER_SELF_URL` is empty in this sandbox, remarks are still stored but you
won't be told about them. Say so when you send the link, and ask the user to
tell you in chat when they're done. Then read the remarks with the `curl`
commands above.
