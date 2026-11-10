---
name: scooter-jupyter
description: >-
  Jupyter notebooks in this sandbox: the `jupyter` web service (JupyterLab with
  this chat in its sidebar) and how to edit and run the user's open notebooks
  live through the jupyter MCP server. Use when the user wants a Jupyter
  notebook, asks you to work in their open .ipynb, or a notebook needs a package.
  Packages go in the notebook's `# /// script` cell, never pip or a venv.
---

# Jupyter in Scooter

Your sandbox can serve **JupyterLab** to the user as the `jupyter` web service.
This conversation sits in lab's left sidebar, so the user can ask you for changes
without leaving it. Real-time collaboration is on: a cell you edit or run shows
up in the user's open tab as it happens, and theirs reach you the same way.

Prefer marimo (the scooter-marimo skill) unless the user asks for Jupyter or
already has `.ipynb` files.

## 1. Start it and give the user the link

```bash
scooter-service start jupyter   # prints the URL to give the user
```

Starting it also starts the `jupyter` MCP server. Notebooks live in `/workspace`.

## 2. Drive notebooks through the MCP tools

Use the `mcp__sandbox-jupyter__*` tools: `use_notebook`, `read_notebook`,
`insert_cell`, `overwrite_cell_source`, `execute_cell`,
`insert_execute_code_cell`, `delete_cell` and the rest. They edit the live
collaborative document, so the user sees each change.

**Attach to the user's kernel.** `use_notebook` joins the kernel of the open
tab only if the notebook has a session already. If it answers "No active sandbox
or Jupyter session was found", it will start a kernel of its own on first run,
and that kernel never gets the notebook's packages. Once the user has the
notebook open, call `unuse_notebook` and then `use_notebook` again. It should
say "for the existing Jupyter session".

**Never edit an open `.ipynb` on disk.** Lab overwrites the file from its live
copy on the next autosave, and your change is lost.

If the tools are missing from your session, call the server over HTTP. It
speaks streamable-HTTP MCP on the port `scooter-mcp list` shows:

```bash
curl -s -X POST http://127.0.0.1:9700/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"use_notebook","arguments":{"notebook_name":"nb","notebook_path":"nb.ipynb"}}}' \
  | sed -n 's/^data: //p'
```

## 3. Kernels and packages

There are two kernels, both on uv-nix (no downloaded CPython; native wheels are
patched so they import):

- **Python (notebook)**, the default. It reads the notebook's first code cell
  that starts with `# /// script` and installs those dependencies when the kernel
  starts:

  ```python
  # /// script
  # dependencies = ["numpy", "matplotlib"]
  # ///
  ```

  To add a package, edit that cell, then restart the kernel. Never `pip install`.
- **Python (workspace)**, one shared venv at `/workspace/.jupyter/venv`.
  `%pip install` works here.

**Restarting after a header change.** The kernel reads the header from disk,
and an edit reaches disk only when lab autosaves, a second or two later. Wait
until the file has it, then restart through Jupyter's API. `restart_notebook`
does not always relaunch the kernel process.

```bash
J=http://127.0.0.1:2719${SCOOTER_SERVICE_PREFIX-/c/$CONVERSATION_ID}/jupyter
until jq -e '.cells[0].source | tostring | contains("matplotlib")' /workspace/nb.ipynb >/dev/null; do sleep 1; done
kid=$(curl -s $J/api/sessions | jq -r '.[] | select(.path=="nb.ipynb") | .kernel.id')
curl -s -X POST $J/api/kernels/$kid/restart
```

A restart clears the notebook's memory, so re-run the cells after it.
Libraries that aren't Python packages come from Nix, through a module under
`/etc/scooter/modules/` (the scooter-env skill).

## If something is off

- `scooter-service status jupyter`, `journalctl -u webservice-jupyter -n 50` and
  `journalctl -u mcp-jupyter -n 50`. `scooter-service restart jupyter` restarts
  lab and the MCP server, and ends every kernel.
- A kernel stuck starting: its first start resolves the header's packages, which
  can take a minute. `ps -ef | grep ipykernel_launcher` shows it.
