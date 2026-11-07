---
name: scooter-publish
type: knowledge
version: 0.1.0
triggers:
- publish a page
- publish a webpage
- static site
- static html
- share a dashboard
- publish a report
- host a page
- persistent url
- share a chart
- publish visualization
---

# Publishing persistent static pages (scooter-publish)

You can publish **static webpages that persist past this session** — the broker
stores the files and serves them at a stable, shareable URL. Use this for
dashboards, generated reports, docs, or interactive visualizations you want a
human to open later, after the sandbox is gone.

There is no CLI wrapper yet: publish through the broker HTTP API shown below.
A 404 from `agent-broker shares` means publishing is not enabled here.

## The model

- You upload **one file**, usually a self-contained `index.html`.
- The broker **mints a UUID** and serves it at:

  ```
  https://<host>/s/<uuid>/            → the page
  https://<host>/s/<uuid>/v/2/        → a specific version
  ```

- The **UUID is the identity** — unguessable, so the link itself is the access
  token ("anyone with the link can view"). There is no page name in the URL.
- **Updating** keeps the same UUID and adds a new version; the root always serves
  the latest. So a link you shared stays live as you update the page.

## Publish

The publish API is JSON, with the file base64-encoded in a one-entry `files`
map. Go through `agent-broker` (it injects your identity; owner = this
conversation):

```bash
B64=$(base64 -w0 /workspace/report.html)
agent-broker shares -X POST -H 'Content-Type: application/json' \
  -d "{\"description\":\"My report\",\"files\":{\"index.html\":{\"content_type\":\"text/html\",\"b64\":\"$B64\"}}}"
# → {"uuid":"7f3c…","url":"https://<host>/s/7f3c…/", ...}
```

**Multi-file and zip shares are disabled.** A share page runs sandboxed, so
behind the login proxy any other file it loads (`chart.png`, `style.css`) gets
redirected to sign-in. Put everything in the one file: inline `<style>` and
`<script>`, and images as `data:` URIs or inline SVG.

## Update, list, delete

```bash
agent-broker shares/<uuid> -X PUT  -H 'Content-Type: application/json' -d "{\"files\":{\"index.html\":{\"b64\":\"$B64\"}}}"
agent-broker shares                      # list your shares (this conversation's)
agent-broker shares/<uuid>               # metadata + file manifest
agent-broker shares/<uuid> -X DELETE     # remove it + all versions
```

## Entry point + file rules

- One file per share; a second file or a `zip_b64` is rejected.
- No external asset files: inline CSS, JS and images (`data:` URIs).
- Allowed types: `.html .css .js .json .csv .txt .md .svg .png .jpg .jpeg .gif
  .webp .ico .woff .woff2 .map .xml .wasm`. No server-side execution — pure static.
- Limit (placeholder): 10 MB.
- HTML pages without a `<link rel="icon">` are served with the Scooter favicon;
  add your own link to override it.

## Interactive graphs with Python

Render everything into one self-contained `index.html`, then publish it:

```python
import base64, io

# static image (matplotlib / seaborn), inlined as a data: URI
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [1, 4, 9]); plt.title("Demo")
buf = io.BytesIO(); plt.savefig(buf, format="png", dpi=150, bbox_inches="tight")
img = base64.b64encode(buf.getvalue()).decode()

# interactive (plotly), with plotly.js inlined
import plotly.graph_objects as go
chart = go.Figure(go.Scatter(x=[1, 2, 3], y=[1, 4, 9])).to_html(full_html=False, include_plotlyjs=True)

open("/workspace/index.html", "w").write(
    "<!doctype html><meta charset=utf-8><h1>Dashboard</h1>"
    f"<img src='data:image/png;base64,{img}'>{chart}"
)
```

Then publish `/workspace/index.html` as above. See the **dataviz** skill
for chart design guidance before writing chart code.

## Showing a share inline in the conversation

To render a published share **live inside the chat** (not just a link), emit a
fenced `scooter-embed` block in your message. The UI turns it into a sandboxed,
fixed-width `<iframe>` of that share:

````
```scooter-embed
share: 7f3c2a1e-1b2c-4d5e-8f90-abcdef012345   # the UUID, or a /s/<uuid>/ path
width: 720      # optional px (clamped to a max); omit for the default width
height: 480     # optional px
center: true    # optional — center the frame in the message
```
````

Notes:
- `share:` must be one of YOUR shares (a UUID or `/s/<uuid>/`). External URLs are
  rejected — the embed can only ever point at a published share.
- The frame is sandboxed (`allow-scripts`, no same-origin), so interactive JS
  charts work but the page can't touch the conversation. The broker sends the
  same sandbox as a CSP, so it applies when the link is opened directly too:
  inline your data and scripts, not `fetch()`, cookies or `localStorage`. A `frame-ancestors` CSP lets shares embed only in the Scooter UI.
- Publish/update the share first (above), then embed it by its UUID.
