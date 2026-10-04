# Searching the web with Brave

This deployment has the **Brave Search** provider wired, so you have a
`brave_search` tool. It returns ranked web results — title, URL and a snippet —
from Brave's own index.

Use it when you need a fact you don't have, or to find the canonical URL for
something you then read with the fetch tool. The normal shape is:

1. `brave_search("<what you want to know>")` — get candidate URLs.
2. Fetch the most promising URL to read the actual page.

A snippet is a *hint*, not a source. If the answer matters — a version number, a
price, an API path — fetch the page and read it rather than quoting the snippet.

## What it is not

- **It is not a replacement for reading the repo.** For anything about code in
  the workspace, search the files; the web does not know this repository.
- **It does not browse.** It returns results; fetching a page is the separate
  fetch tool, which is also what handles a URL someone hands you directly.

## When it fails

The key lives in the **broker**, not in your sandbox — you cannot read it, and
you don't need to. Two failures look different on purpose:

- `brave_search FAILED (HTTP 404) from the broker` — the Brave provider is not
  mounted (no API key configured in this deployment). Say so; do not retry, and
  do not try to reach Brave with `curl` instead. There is no key in the sandbox
  for you to use.
- `brave_search FAILED (HTTP 401/429)` — the key is wired but rejected or out of
  quota. Report the status; retrying an exhausted quota just burns turns.

Either way the message carries the broker's verbatim status and body. Read it
rather than guessing, and prefer reporting a configuration problem to the human
over working around it.

If both `brave_search` and `kagi_search` are present, either is fine — they are
independent providers over different indexes. Don't run both for the same query
by default; pick one, and only try the other if the first comes back thin.
