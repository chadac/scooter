---
name: scooter-web-services
type: knowledge
version: 1.0.0
triggers:
- open a notebook
- marimo
- jupyter notebook
- run a notebook
- web terminal
- web vscode
- code editor in the browser
- open a ui
- web service
- serve a ui
- xterm
- start a service for the user
- let me see it in the browser
- pair on a notebook
---

# Offering web services (marimo, a terminal, VS Code) to the user

You can run a **web service inside your sandbox** and the user opens it in their
browser at `https://<host>/c/<conversation-id>/<service>/`. The platform reverse-
proxies (HTTP **and** WebSocket) into your pod — the user needs no port-forward.
Use this when a task is better *shown* than described: exploring data in a
notebook, giving the user a live terminal, or a browser code editor.

## The two ways a service appears

1. **Built-ins** — declared in the platform. `marimo` ships today. The user
   enables/opens it from the **Services panel** in the conversation UI, OR you can
   enable + start it (below). Prefer built-ins when one fits.
2. **Your own** — any service you declare in a module under `/etc/scooter/modules/`
   (see the scooter-env skill) using the `webServices.<name>` option, then
   `scooter-rebuild switch`. The platform then proxies it and lists it in the
   Services panel.

## Declaring a web service (webServices.<name>)

Add it in a NixOS module under `/etc/scooter/modules/<name>.nix` and apply it with
`scooter-rebuild switch` (see the scooter-env skill). The service MUST serve under
its base path `/c/$CONVERSATION_ID/<name>` — `CONVERSATION_ID` is in the pod env.
Package heavy servers as a **lazy tool** so the switch stays fast (built on first
start, see scooter-env).

```nix
{ pkgs, ... }: {
  # marimo binary on PATH, built on first start (light — no eager build).
  programs.lazyTools.tools.marimo = { package = "marimo"; };

  webServices.marimo = {
    enable = true;
    port = 2718;                       # in-pod port (unique per service)
    displayName = "marimo";
    user = "root";                     # writes notebooks to /workspace
    workingDirectory = "/workspace";
    # Serve UNDER the base path; --proxy makes absolute URLs correct.
    command = ''
      ${pkgs.bash}/bin/bash -c 'exec marimo edit \
        --host 0.0.0.0 --port 2718 \
        --base-url "/c/''${CONVERSATION_ID}/marimo" \
        --headless --no-token'
    '';
    # Escape hatch for extra systemd knobs (hardening, ordering, limits):
    # extraConfig.serviceConfig.LimitNOFILE = 65536;
  };
}
```

Key rules for the `command`:
- Bind `--host 0.0.0.0` (the agent-host reaches the pod IP, not localhost).
- Serve under `--base-url /c/$CONVERSATION_ID/<name>` (or the equivalent flag:
  VS Code `--server-base-path`, etc.) — a service hardcoded to `/` breaks behind
  the proxy.
- `--no-token` / disable the service's own auth: the platform proxy already gates
  access; an in-pod token would just block the user (and marimo-pair, below).

## Starting a service and giving the user the link

Services use **explicit start** (they don't auto-run). After enabling one:
- Tell the user it's in the **Services panel** — they click **Start**, then
  **Open**. This is the simplest path.
- Or start it yourself: `systemctl start webservice-<name>` (once
  `scooter-rebuild status` reports the switch is `ready`), then share the URL:
  `https://<host>/c/$CONVERSATION_ID/<name>/`. Use `$CONVERSATION_URL` for the
  host if you need the full origin.

Check it's up: `systemctl is-active webservice-<name>` and
`curl -fsS localhost:<port>/c/$CONVERSATION_ID/<name>/ >/dev/null`.

## marimo: pairing with the running notebook (marimo-pair)

Once a marimo service is running with `--no-token`, you can **drive the notebook
yourself** (add cells, run code, read outputs) while the user watches live —
`marimo-pair` is the agent-side tool for this. It is NOT a web service; it's a
skill you attach to the *running* marimo server.

Prereqs: `bash`, `curl`, `jq` on PATH (jq via a lazy tool if missing). Install +
use per its README:

```bash
# install the marimo-pair skill (auto-discovers the --no-token server)
npx skills add marimo-team/marimo-pair
# then follow the skill's discover/execute scripts against the running notebook
```

Typical flow: enable + start `webServices.marimo`, tell the user to Open it, then
use marimo-pair to build the notebook collaboratively. The user edits in their
browser; you edit via marimo-pair; both see the same reactive notebook.

## Good candidates to offer

- **marimo** — data exploration, a computed report, teaching a concept
  interactively. The flagship; pairs with marimo-pair.
- **a web terminal** (ttyd/wetty) — when the user wants to poke around the sandbox
  themselves.
- **web VS Code** (code-server) — when the user wants to browse/edit the workspace
  in a full editor.

Don't spin one up unprompted for trivial tasks — offer it when seeing-it beats
telling-it, or when the user asks to look around / pair.
