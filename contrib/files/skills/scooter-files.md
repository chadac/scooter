---
name: scooter-files
type: knowledge
version: 1.0.0
triggers:
- show me the file
- open the file
- let me see the code
- browse the workspace
- look at the repo together
- review this file with me
- file viewer
- share a file
- walk me through the code
- read along
---

# Showing the user a file in the workspace (scooter-files)

You can give the user a **read-only view of your workspace in their browser**, at
the `files` service's URL: `$SCOOTER_SERVICES_ORIGIN/files/` when the deployment
gives each conversation its own origin, else `https://<host>/c/$CONVERSATION_ID/files/`.
It is a web service like the terminal
or marimo — same Services panel, same `scooter-service` commands — but scoped to
one job: looking at a file together.

Use it when the subject of the conversation **is a file**: a document you drafted,
a module you are about to change, a config the user needs to eyeball. Pasting a
400-line file into chat buries the conversation; a link keeps the file beside it.

## Opening it

```bash
# Starts it (it also survives a suspend/resume) and builds the full link.
FILES=$(scooter-service start files | sed -n 's/^url: //p')
# A path (/c/<id>/files/) means the main host: prefix the origin of $CONVERSATION_URL.
case "$FILES" in /*) FILES="$(echo "$CONVERSATION_URL" | sed -E 's#^(https?://[^/]+).*#\1#')$FILES" ;; esac
echo "${FILES}?path=docs/design.md"
```

Then give the user the link. Deep-link straight to what you are talking about
rather than dropping them at the root: the viewer takes the file as the `path`
query parameter, as above. You do not
have to pre-start it: if the user opens a declared service that isn't running, the
platform auto-starts it.

## What it shows

- A tree of `/workspace`, directories first, with dotfiles hidden and heavy
  directories (`node_modules`, `.git`, `__pycache__`, `result`) dimmed rather than
  walked. Git repositories are badged.
- Any text file with line numbers and syntax highlighting.
- **Markdown as a rendered document** — headings, tables, task lists, images, and
  highlighted code fences — with a `raw` toggle for the source. So link a design
  doc or a README when you want it *read*, not inspected.
- **Images** (PNG, JPEG, GIF, WebP, SVG, AVIF, ICO, BMP, up to 16 MB): link one
  directly to show it, or embed it in a document with `![alt](shot.png)`, a
  `/workspace/...` path, or an HTML `<img src=… width=…>` to size it.
- **HTML pages** (`.html`, `.htm`) rendered in a sandboxed frame, with a Source
  toggle. Scripts run, and CDN (`https:`) scripts, styles and fonts load, but the
  page can't `fetch` anything. Relative `<img>` files load; relative CSS and JS
  don't, so inline them. Good for charts and reports you want *seen*.
- Other binaries and text files past 2 MB report themselves instead of rendering —
  say so rather than retrying.

Two things worth using in a link, because they land the user where you mean:

- A heading anchor: `?path=docs/design.md#failure-modes` opens that section.
- Links *inside* a rendered document resolve against the workspace, so a user who
  follows a doc's reference to `../contrib/files/sandbox.nix` stays in the viewer.

## Designing with the user

For design work, readers can comment on lines and answer question fields in the
viewer, and each remark wakes you. Answer with `scooter-files reply <thread> "…"`
and close with `scooter-files resolve <thread>`; see the `scooter-design-review`
skill.

## It is read-only, and it is not your own file access

The viewer has no write path. If the user asks for a change while looking at it,
**you** make the edit with your normal tools. The open page picks it up within
a second or so, so there is no need to ask them to reload.

Nor is it a way for *you* to read files — you have the filesystem directly. Open
the viewer only to show the **user** something. Reading a file into your own
context to answer a question, and showing it to a human, are different jobs.

## Context cost

When you *do* need a file in your own context, read the whole file rather than a
slice of it. A truncated document is the expensive failure here: you answer
confidently from the half you saw. If a file is genuinely too large to hold, say
which part you read and which you did not.
