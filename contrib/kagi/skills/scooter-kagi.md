# Searching the web with Kagi

This deployment has the **Kagi Search** provider wired, so you have a
`kagi_search` tool. It returns ranked web results — title, URL and a snippet —
from Kagi's index.

Use it when you need a fact you don't have, or to find the canonical URL for
something you then read with the fetch tool. The normal shape is:

1. `kagi_search("<what you want to know>")` — get candidate URLs.
2. Fetch the most promising URL to read the actual page.

A snippet is a *hint*, not a source. If the answer matters — a version number, a
price, an API path — fetch the page and read it rather than quoting the snippet.

**Kagi searches are metered and not cheap** (no free tier, billed per request).
That is not a reason to avoid the tool when you need it, but it is a reason not
to fire several near-identical queries where one good one would do, and not to
re-run a search whose results you already have in context.

## What it is not

- **It is not a replacement for reading the repo.** For anything about code in
  the workspace, search the files; the web does not know this repository.
- **It does not browse.** It returns results; fetching a page is the separate
  fetch tool, which is also what handles a URL someone hands you directly.

## When it fails

The key lives in the **broker**, not in your sandbox — you cannot read it, and
you don't need to. Two failures look different on purpose:

- `kagi_search FAILED (HTTP 404) from the broker` — the Kagi provider is not
  mounted (no API key configured in this deployment). Say so; do not retry, and
  do not try to reach Kagi with `curl` instead. There is no key in the sandbox
  for you to use.
- `kagi_search FAILED (HTTP 401/429)` — the key is wired but rejected or out of
  quota. Report the status; retrying an exhausted quota just burns turns.

Either way the message carries the broker's verbatim status and body. Read it
rather than guessing, and prefer reporting a configuration problem to the human
over working around it.

If both `kagi_search` and `brave_search` are present, either is fine — they are
independent providers over different indexes. Don't run both for the same query
by default; pick one, and only try the other if the first comes back thin.
