---
name: scooter-marimo
description: >-
  marimo notebooks in this sandbox: the `marimo` web service and how to pair on it
  with the marimo-pair skill. Use when the user wants a notebook, data exploration,
  plots or an interactive report, or asks you to work in their open notebook.
---

# marimo in Scooter

Your sandbox can serve a **marimo notebook** to the user as the `marimo` web
service, and you can drive that same notebook yourself with the **marimo-pair**
skill: run code in its kernel, read live variables, and add, edit and run cells.
The user watches and edits in their browser at the same time.

Reach for it when seeing beats telling: exploring data, plotting, or a computed
report the user can poke at. Don't start one for a quick calculation; use your
shell for that.

## 1. Start it and give the user the link

```bash
scooter-service start marimo
ORIGIN=$(echo "$CONVERSATION_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
echo "$ORIGIN/c/$CONVERSATION_ID/marimo/"
```

The user can also start it from the **Services panel**. The first start
materializes marimo, which takes a while. Notebooks live in `/workspace`.

**marimo-pair can only reach a notebook the user has open in the browser.** A
session exists only while a tab has the notebook open. So ask the user to open
the link, and to create or pick a notebook, before you pair.

## 2. Pair with marimo-pair

Read the **marimo-pair** skill and follow it. Two things differ here:

- **Pass `--url` explicitly.** Our server runs headless under a base path, so
  `discover-servers.sh` won't find it. Use:

  ```bash
  bash /etc/scooter/skills/marimo-pair/scripts/execute-code.sh \
    --url "http://localhost:2718/c/$CONVERSATION_ID/marimo" \
    -c "import marimo._code_mode as cm; help(cm)"
  ```

  With several notebooks open, add `--file <notebook.py>`.
- **Its scripts are in your sandbox** at `/etc/scooter/skills/marimo-pair`.
  `curl` and `jq` are on PATH.

marimo-pair's rules hold as written:
- Don't edit the `.py` file while a session is running.
- Make notebook changes through `marimo._code_mode`.
- Add packages with `ctx.packages.add()`, not `pip` or `uv`. Each notebook is a
  `--sandbox` notebook with its own environment and inline (PEP 723)
  dependencies.

## If something is off

- `scooter-service status marimo` and `journalctl -u webservice-marimo -n 50`
  show the server's state and log.
- "Failed to connect": the service isn't running, or the URL lacks the
  `/c/$CONVERSATION_ID/marimo` base path.
- "No sessions": nobody has the notebook open. Ask the user to open the link.
