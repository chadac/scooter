---
name: slack-formatting
type: knowledge
version: 1.0.0
triggers:
- respond in slack
- reply in slack
- slack_respond
- post to slack
- format slack
- slack formatting
- slack markdown
- mrkdwn
- bold in slack
- link in slack
- code block in slack
---

# Formatting Slack messages (mrkdwn — NOT Markdown)

When you post to Slack (`slack_respond`), Slack does **NOT** render standard
Markdown. It uses its own **mrkdwn**. If you write Markdown out of habit, it shows
up **literally and broken** — `**bold**` appears as `**bold**`, `[text](url)`
appears as the raw brackets, `#` headers and tables don't render at all. Format
for mrkdwn instead.

## The differences that bite (Markdown → what Slack wants)

| You want | Markdown (WRONG in Slack) | Slack mrkdwn (RIGHT) |
|----------|---------------------------|----------------------|
| **bold** | `**bold**` | `*bold*` (single asterisks) |
| _italic_ | `*italic*` or `_italic_` | `_italic_` (underscores) |
| ~~strike~~ | `~~strike~~` | `~strike~` (single tildes) |
| link | `[text](https://url)` | `<https://url|text>` |
| bare link | `<url>` or `url` | `https://url` (auto-links) |
| inline code | `` `code` `` | `` `code` `` (same) |
| code block | ```` ```lang ```` | ```` ``` ```` (NO language tag) |
| bullet list | `- item` | `• item` (use a real bullet, or `-`) |
| heading | `# Title` | *no headings* — use `*Title*` on its own line |
| blockquote | `> quote` | `> quote` (same) |
| table | `| a | b |` | *not supported* — use lines or a code block |

Key ones to remember: **`*single asterisks*` for bold** (not `**`), **`<url|text>`
for links** (not `[text](url)`), **no `#` headings**, **no tables**.

## Practical rules

- Keep it short and skimmable — a Slack thread reply, not a document. Prefer a
  couple of lines + a short bullet list over headings and long prose.
- For a set of items, use `•` bullets (or a short `-` list); don't build a table.
- To share a link, write `<https://github.com/org/repo/pull/5|PR #5>` — a bare
  `https://…` also works (Slack auto-links it), which is often cleaner.
- Multi-line code / logs / diffs: a plain triple-backtick block (no language).
- Mention a person only if you actually mean to ping them: `<@U123>` by user id.
  Don't write `@name` as text expecting a mention.

## Example

Instead of this Markdown:
```
## Done ✅
I fixed the bug in **auth.py** — see [the PR](https://github.com/o/r/pull/7).
```
post this mrkdwn:
```
*Done* ✅
I fixed the bug in `auth.py` — see <https://github.com/o/r/pull/7|the PR>.
```

(GitHub / GitLab / Jira comments DO take normal Markdown — this mrkdwn guidance is
Slack-only.)
