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

> Status: **scaffold**. The broker `shares` subsystem exists behind the
> `SHARES_ENABLED` flag; a `scooter-publish` CLI wrapper is a follow-up. Until
> then, publish via the broker HTTP API shown below.

## The model

- You upload a **bundle** — one file, or several (HTML + CSS + images + a chart).
- The broker **mints a UUID** and serves the bundle at:

  ```
  https://<host>/s/<uuid>/            → the entry point (index.html)
  https://<host>/s/<uuid>/chart.png   → any file in the bundle
  https://<host>/s/<uuid>/v/2/        → a specific version
  ```

- The **UUID is the identity** — unguessable, so the link itself is the access
  token ("anyone with the link can view"). There is no page name in the URL.
- **Updating** keeps the same UUID and adds a new version; the root always serves
  the latest. So a link you shared stays live as you update the page.

## Publish (single file or multi-file zip)

The publish API is JSON — files are base64. Supply EITHER an inline `files` map
OR a base64 `zip_b64` the broker unpacks. Go through `agent-broker` (it injects
your identity; owner = this conversation):

```bash
# multi-file: zip a directory, base64 it, publish
cd /workspace/dashboard && zip -qr /tmp/site.zip .
ZIP_B64=$(base64 -w0 /tmp/site.zip)
agent-broker shares -X POST -H 'Content-Type: application/json' \
  -d "{\"description\":\"My dashboard\",\"zip_b64\":\"$ZIP_B64\"}"
# → {"uuid":"7f3c…","url":"https://<host>/s/7f3c…/", ...}
```

```bash
# single file
B64=$(base64 -w0 /workspace/report.html)
agent-broker shares -X POST -H 'Content-Type: application/json' \
  -d "{\"files\":{\"index.html\":{\"content_type\":\"text/html\",\"b64\":\"$B64\"}}}"
```

## Update, list, delete

```bash
agent-broker shares/<uuid> -X PUT  -H 'Content-Type: application/json' -d "{\"zip_b64\":\"$ZIP_B64\"}"
agent-broker shares                      # list your shares (this conversation's)
agent-broker shares/<uuid>               # metadata + file manifest
agent-broker shares/<uuid> -X DELETE     # remove it + all versions
```

## Entry point + file rules

- Entry point resolution: an explicit `entry_point`, else `index.html`, else the
  sole file if the bundle has exactly one. Otherwise the publish is rejected — put
  an `index.html` at the bundle root.
- All asset paths must be **relative** (`<img src="chart.png">`), not absolute.
- Allowed types: `.html .css .js .json .csv .txt .md .svg .png .jpg .jpeg .gif
  .webp .ico .woff .woff2 .map .xml .wasm`. No server-side execution — pure static.
- Limits (placeholder): 10 MB/file, 100 MB/bundle, 200 files.

## Interactive graphs with Python

Render to a file, embed it in `index.html`, then publish the directory:

```python
import os
os.makedirs("/workspace/dashboard", exist_ok=True)

# static image (matplotlib / seaborn)
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [1, 4, 9]); plt.title("Demo")
plt.savefig("/workspace/dashboard/chart.png", dpi=150, bbox_inches="tight")

# interactive (plotly) — self-contained HTML you can <iframe> or link
import plotly.graph_objects as go
go.Figure(go.Scatter(x=[1, 2, 3], y=[1, 4, 9])).write_html("/workspace/dashboard/chart.html")

open("/workspace/dashboard/index.html", "w").write(
    "<!doctype html><meta charset=utf-8><h1>Dashboard</h1>"
    "<img src='chart.png'><iframe src='chart.html' width=100% height=500></iframe>"
)
```

Then zip `/workspace/dashboard` and publish as above. See the **dataviz** skill
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
  charts work but the page can't touch the conversation. The broker also sends a
  `frame-ancestors` CSP so shares embed only in the Scooter UI, nowhere else.
- Publish/update the share first (above), then embed it by its UUID.
