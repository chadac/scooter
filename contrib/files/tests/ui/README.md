# Driving the viewer in a browser

The viewer's write half is a UI, and the bugs a reviewer hit in it — a comment button
that did nothing, a submit that lagged long enough to be pressed twice and leave two
comments, replies and deletes that did not exist — were all invisible to the pytest
suites and to the nixosTest, because neither of those clicks anything. This script
does.

It is not wired into CI yet (see the note at the bottom); it is the harness the
frontend was developed against, kept so the next change to it can be checked the
same way rather than by eye.

From the repo root, inside `nix develop` (which exports `PW_CHROME`), after `npm ci`:

    npm --prefix contrib/files/viewer-ui ci
    npm --prefix contrib/files/viewer-ui run build
    node contrib/files/tests/ui/viewer.ui.mjs

The script is self-contained: it starts `contrib/files/viewer/server.py` over a
scratch workspace, alongside a stub broker it can read back, and removes both when
it exits. Nothing needs to be running beforehand.

- `FILES_VIEWER_STATIC`: the built frontend. Defaults to `viewer-ui/dist`; to test
  exactly what ships, point it at the output of the Nix package in
  `contrib/files/viewer-ui/default.nix`, which `sandbox.nix` builds.
- `FILES_VIEWER_PYTHON`: the interpreter for `server.py` (default `python3`; it
  needs only the standard library).

`playwright` comes from the root `package.json` (it is what `@playwright/test`
installs), so there is nothing to install beside it. The script launches
`PW_CHROME` directly rather than Playwright's own browser download.

What it asserts, each one a bug that shipped or a contract someone relies on:

- the markdown renders and its code fences are highlighted
- selecting text opens a composer; submitting locks the button, so a slow round trip
  cannot be pressed twice into two comments
- a comment anchors to its paragraph's source line and paints the quoted passage
- a reply shares its parent's thread, as one card and with no second mark
- the sending badge clears with no user action, and both reach the broker
- the cards do not overlap
- deleting a reply keeps the comment; deleting one thread leaves the other; the
  deletes reach the broker
- answering a question card records the answer
- links, in the format the scooter-files skill hands out: `?path=<file>#<heading>`
  opens the file scrolled to that heading; a document's images load from the
  workspace; a relative link opens its target in the viewer and Back returns; an old
  `#/<file>` link still opens and is rewritten to `?path=`
- images: a `/workspace/...` path and HTML `<img>` tags (block and inline, width kept) load in a document, an image inside a sentence stays inline; an image file opened on its own is shown with its size
- an HTML file renders in its frame, with its script running and its relative image loaded; that script
  can't reach the viewer's page, its cookies or its API; Source shows the HTML
- in a code file, a range comment anchors to its first line, quotes the range, and
  its thread renders inline under those lines
- no page errors

CI home: this belongs in the Playwright suite under `test/e2e`, which already has the
pinned browser and the sharding. It is kept out for now because that suite boots the
whole agent-host stack per run and this needs only the viewer and a broker stub —
wiring it in means a lighter project in `playwright.config.ts` that runs this script.
