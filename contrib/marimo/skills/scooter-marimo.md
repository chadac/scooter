---
name: scooter-marimo
description: >-
  marimo notebooks in this sandbox: the `notebook` web service and how to pair on it
  with the marimo-pair skill. Use when the user wants a notebook, data exploration,
  plots or an interactive report, asks you to work in their open notebook, or a
  notebook needs a package or a setting changed. Each notebook has its own
  environment: add packages with ctx.packages.add(), never pip, a venv or a
  pyproject.toml. Settings go in ~/.config/marimo/marimo.toml.
---

# marimo in Scooter

Your sandbox can serve a **marimo notebook** to the user as the `notebook` web
service, and you can drive that same notebook yourself with the **marimo-pair**
skill: run code in its kernel, read live variables, and add, edit and run cells.
The user watches and edits in their browser at the same time.

Reach for it when seeing beats telling: exploring data, plotting, or a computed
report the user can poke at. Don't start one for a quick calculation; use your
shell for that.

## 1. Start it and give the user the link

```bash
scooter-service start notebook   # prints the URL to give the user
```

The `notebook` service ("Notebook" in the Services panel) is the marimo editor. This
conversation is in its sidebar: marimo's **Agent panel** (labelled "Claude") chats
here, so the user can ask you for changes without leaving the notebook. Their messages
from it arrive as ordinary messages, with the open notebook's path ("Attached: …").
The first may also carry marimo's own agent rules (`marimo_rules.md`); where they
differ from this skill and marimo-pair, follow these. The panel shows
replies, tool calls and approvals, but not Scooter-only parts like the Services panel
or kanban, so link the full chat when you need those. The user can also start it from
the **Services panel**. The first start materializes marimo, which takes a while.
Notebooks live in `/workspace`.

**marimo-pair can only reach a notebook the user has open in the browser.** A
session exists only while a tab has the notebook open. So ask the user to open
the link, and to create or pick a notebook, before you pair.

## 2. Pair with marimo-pair

Read the **marimo-pair** skill and follow it. Two things differ here:

- **Pass `--url` explicitly.** Our server runs headless under a base path, so
  `discover-servers.sh` won't find it. Use:

  ```bash
  # marimo serves at /notebook on the conversation's own origin, else under /c/<id>/notebook.
  MARIMO_BASE=${SCOOTER_SERVICES_ORIGIN:+/notebook}; MARIMO_BASE=${MARIMO_BASE:-/c/$CONVERSATION_ID/notebook}
  bash /etc/scooter/skills/marimo-pair/scripts/execute-code.sh \
    --url "http://localhost:2718$MARIMO_BASE" \
    -c "import marimo._code_mode as cm; help(cm)"
  ```

  With several notebooks open, add `--file <notebook.py>`.
- **Its scripts are in your sandbox** at `/etc/scooter/skills/marimo-pair`.
  `curl` and `jq` are on PATH.

marimo-pair's rules hold as written:
- Don't edit the `.py` file while a session is running.
- Make notebook changes through `marimo._code_mode`.
- Add packages with `ctx.packages.add()` (next section).

## 3. Packages: each notebook has its own environment

A notebook's dependencies are its inline (PEP 723) header, and marimo builds the
notebook's own environment from it. That environment is not your shell's Python.
**Never create a `pyproject.toml`, `requirements.txt` or venv for a notebook, and
never `pip install` for one.** None of these reach it.

- **The notebook is open:** add packages through marimo-pair, then re-run the cells
  that need them. Adding a package doesn't re-run anything.

  ```python
  async with cm.get_context() as ctx:
      ctx.packages.add("polars", "altair")   # or ctx.packages.remove(...)
  ```

  It installs into the running kernel and pins the version in the header. Don't edit
  the header on disk while the notebook is open: the kernel ignores it until it restarts.
- **"restart the kernel to use them":** the header has the change, but the open kernel
  can't load it until it restarts. A restart loses everything the notebook holds in
  memory. Restarting from outside also leaves the user's tab showing "kernel not
  found" until they reload it. So gauge how active the user is first:
  - **They're working in it now** (messages about it in the last few minutes, or the
    file saved recently: `stat -c %y nb.py`): ask them to use marimo's own restart,
    which reloads their tab cleanly.
  - **They seem to be away:** restart it yourself, and tell them to reload the tab
    when they're back.

  ```bash
  M=http://localhost:2718$MARIMO_BASE; F=nb.py   # the notebook's path under /workspace
  sid=$(curl -s "$M/api/sessions" | jq -r --arg f "/workspace/$F" 'to_entries[] | select(.value.path == $f) | .key')
  tok=$(curl -s "$M/?file=$F" | grep -o 'data-token="[^"]*"' | cut -d'"' -f2)
  curl -s -X POST "$M/api/kernel/restart_session?file=$F" -H "Marimo-Session-Id: $sid" \
    -H "Marimo-Server-Token: $tok" -H 'Content-Type: application/json' -d '{}'
  ```

  If `/api/sessions` lists no session for the notebook, there is no kernel to
  restart: the next open builds the environment from the header. A session can
  outlive its tab for a while, so check rather than assume.
- **A new notebook nobody has open yet:** write the header when you create the file.

  ```python
  # /// script
  # requires-python = ">=3.12"
  # dependencies = ["marimo", "polars"]
  # ///
  ```
- **Not a Python package** (a CLI tool, or a C library a wheel needs): it comes from
  Nix. Add it with a module under `/etc/scooter/modules/` (the scooter-env skill).
- Leave the environments themselves (`/root/.cache/uv/environments-v2/`) alone; marimo
  owns them.

### Running a notebook from your shell

There is no `python` on PATH: use `uv`, never `python` or `pip`. `uv run nb.py` runs
the notebook as a script in the environment its header declares, so it is how you
check a notebook you wrote before the user opens it. The `uv` on PATH is the uv-nix one
the server uses: it takes its Python from nixpkgs rather than downloading one, and
patches native wheels so they import on NixOS.

## 4. Settings

marimo's settings are in `~/.config/marimo/marimo.toml`, on the workspace volume.
The marimo settings panel writes the same file, so the user and you share it. marimo
reads it whenever a notebook opens, so changes need no restart.

- Notebooks **run when opened** (`runtime.auto_instantiate = true`), so a bookmark
  that wakes the sandbox lands on a computed notebook. Leave that on unless the user
  asks otherwise.
- **Never put marimo settings in a `pyproject.toml`.** The server only reads
  `/workspace/pyproject.toml`, never one beside a notebook, and creating that one
  makes the whole workspace a uv project.

## If something is off

- `scooter-service status notebook` and `journalctl -u webservice-notebook -n 50`
  show the server's state and log. `scooter-service restart notebook` restarts it,
  which ends every open kernel.
- The Agent panel says "disconnected" or shows no history: reload the tab. If it
  persists, check that `experimental.external_agents` isn't set to false in
  marimo.toml.
- "Failed to connect": the service isn't running, or the URL lacks marimo's base
  path (`$MARIMO_BASE` above).
- "No sessions": nobody has the notebook open. Ask the user to open the link.
- `ImportError: libstdc++.so.6` (or another `.so`) from a wheel: uv-nix did not patch
  the environment, usually because the `patchelf` it resolved is not in the store
  (`uv nix patch -v <venv>` shows `Failed to patch ...: No such file or directory`).
  `nix-store --realise` that patchelf path, then re-run; uv-nix re-patches on the next run.
