---
name: scooter-web-review
description: >-
  Web app review: show the user a web app you're building beside this chat, and get
  their notes pinned on it. Use when you build or change a web UI (an SPA, a dashboard,
  a site with a dev server) and the user should look at it, or when they ask to review
  or comment on an app. Notes on the page wake you; answer with `review reply` and
  close them with `review resolve`.
---

# Web app review

The **Review** web service puts this conversation on the left and an app running in
your sandbox on the right. The user browses the app as usual, and with the toolbar
above it they can pin a note on an element (**Point**, `C`) or on a rectangle they
drag (**Area**, `R`). Each note wakes you with the route, the element and a
screenshot.

## 1. Point it at the app

The app is served to the browser under a path prefix, its **base path**, and it has
to know it, the same way it would behind any reverse proxy: assets, links and the
router all resolve against it. `review status` prints it as `REVIEW_BASE` (for
example `/review-app/`).

Review is off until it has an app. `review target` does everything in one step: it
writes `/etc/scooter/modules/web-review-target.nix` (`webReview.target`), runs
`scooter-rebuild switch`, which turns Review on and lists it in the user's Services
panel, and (re)starts Review. Prefer a way that starts the app with Review, so it
comes back by itself after the sandbox suspends or restarts:

- Let Review run the dev server. It runs as the unit `webservice-review-dev` with
  `REVIEW_BASE`, `REVIEW_PUBLIC_URL` and `PORT` in its environment, and your `PATH`:

  ```bash
  review target --run 'npm run dev -- --port 5173 --base "$REVIEW_BASE"' --cwd /workspace/my-app --port 5173
  ```

- Or point it at a systemd unit you declared yourself (see the `scooter-env`
  skill), which Review then starts and waits for:

  ```bash
  review target --unit my-app --port 5173
  ```

- Or point it at a port something else serves:

  ```bash
  review target 5173
  ```

`review target` prints the URL. Give it to the user as a markdown link. Run it
again to change the app; `review target --clear` turns Review off.

Framework settings for the base path:

| Framework | Setting |
|---|---|
| Vite | `--base "$REVIEW_BASE"`; HMR goes through the proxy unless `server.hmr.port` pins another port |
| Next.js | `basePath` and `assetPrefix` set to the base without its trailing slash |
| Create React App | `PUBLIC_URL`, and `basename` on the router |
| Flask, Django, Express | mount the app under the base, or honour `X-Forwarded-Prefix` |

The browser never reaches the sandbox's `localhost`. The proxy rewrites redirects,
cookies and absolute `http://localhost:<port>` URLs in pages, scripts and styles, so
an app that leaks one still works. Don't give the user a bare port.

If the page says "Waiting for the dev server", the target isn't answering. With
`--run`, `journalctl -u webservice-review-dev` has the dev server's output; with
`--unit`, that unit's journal.

## 2. Notes

A note arrives as a message like this:

```
Review note #4 (area) on /orders/42, viewport 1440×900 (light):
  area 312,180 → 860,420 inside `main > section.summary` ("Order total $1,204 …")
  overlaps: `.summary .total`, `.summary .badge[data-status="late"]`
> These numbers are cramped, give the totals more room.
Screenshot: /workspace/.scooter/review/shots/4.png
```

- Look at the screenshot with your image tool when the selector and text don't
  settle it. A note marked "may be incomplete" was captured with blank regions
  (cross-origin images, WebGL, video).
- Make the change. The dev server reloads the page.
- `review reply 4 "Gave the totals their own row."` puts your answer on the pin.
- `review resolve 4` turns the pin green. The user can reopen it or reply, which
  wakes you again.

`review list` shows the open notes and their threads (`--all` adds resolved ones).

## 3. Seeing what the user sees

`review snap` asks the user's open review page for a screenshot of exactly what it
shows (their size, theme and page state) and prints the PNG's path. Use it to check
an edit landed. With no page open it falls back to a headless browser
(`--route /orders/42` picks the page), which can't reproduce the user's state.
`review show <id>` prints a note's screenshot, or renders one headless.

## Commands

```
review target <port> | --run CMD --port N [--cwd DIR] | --unit NAME --port N | --clear
review status | list [--all] | show <id> | snap [--route /path]
review reply <id> "…" | resolve <id> | reopen <id>
```
