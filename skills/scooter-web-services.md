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

1. **Shipped** — declared by the platform's contribs where this deployment enables
   them: `marimo` (notebooks; see the scooter-marimo skill), `vscode` (browser VS
   Code) and `files` (the workspace viewer), plus the built-in `terminal`. The user
   starts/opens one from the **Services panel** in the conversation UI, OR you can
   start it (below). Prefer a shipped one when it fits.
2. **Your own** — any service you declare in a module under `/etc/scooter/modules/`
   (see the scooter-env skill) using the `webServices.<name>` option, then
   `scooter-rebuild switch`. The platform then proxies it and lists it in the
   Services panel.

## Declaring a web service (webServices.<name>)

Add it in a NixOS module under `/etc/scooter/modules/<name>.nix` and apply it with
`scooter-rebuild switch` (see the scooter-env skill). The service MUST serve under
its base path `/c/$CONVERSATION_ID/<name>` — `CONVERSATION_ID` is in the pod env.
A heavy server is built or downloaded during the switch, so `scooter-rebuild
status` will sit in `building` for a while. `marimo`, `ttyd` and `code-server`
are exceptions — the image already ships them as stubs, so referencing them is
free until the service actually starts.

```nix
{ pkgs, ... }: {
  webServices.notebooks = {
    enable = true;
    port = 2728;                       # in-pod port (unique per service)
    displayName = "notebooks";
    user = "root";                     # writes notebooks to /workspace
    workingDirectory = "/workspace";
    # Serve UNDER the base path; --proxy makes absolute URLs correct.
    command = ''
      ${pkgs.bash}/bin/bash -c 'exec marimo edit \
        --host 0.0.0.0 --port 2728 \
        --base-url "/c/''${CONVERSATION_ID}/notebooks" \
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
  access; an in-pod token would just block the user (and marimo-pair).

**Who can open the link.** Any signed-in user, not just the owner, so links can be
shared. Don't serve anything private. The caller's id arrives as `x-scooter-user`.

## Starting a service and giving the user the link

Prefer **`scooter-service start <name>`** (not raw `systemctl start`). It starts the
unit AND records the service in `/workspace/.scooter/services.json` on the workspace
PVC — so after the sandbox hibernates and resumes, a boot oneshot
(`scooter-service-restore`) brings the service back automatically. Raw `systemctl
start` would run once and be lost on the next resume. `scooter-service stop <name>`
clears that intent (a service the user stopped stays stopped across a resume).

After enabling one:
- Tell the user it's in the **Services panel** — they click **Start**, then
  **Open**. (The panel's Start goes through the same persisted path.)
- Or start it yourself: `scooter-service start <name>` (once `scooter-rebuild
  status` reports the switch is `ready`), then share the URL:
  `https://<host>/c/$CONVERSATION_ID/<name>/`. Use `$CONVERSATION_URL` for the
  host if you need the full origin.

You don't have to pre-start it just to share the link: if the user opens a declared
service that isn't running yet, the platform **auto-starts it** and shows a loading
page (a spinner + the service's live log) that loads the app once it's healthy.

Check it's up: `scooter-service status <name>` (or `systemctl is-active
webservice-<name>`) and `curl -fsS localhost:<port>/c/$CONVERSATION_ID/<name>/
>/dev/null`.

## Good candidates to offer

- **marimo** — data exploration, a computed report, teaching a concept
  interactively. The flagship: you pair on it with marimo-pair (scooter-marimo
  skill).
- **a web terminal** (ttyd/wetty) — when the user wants to poke around the sandbox
  themselves.
- **web VS Code** (code-server; the `vscode` service, when contrib/code-server is
  enabled) — when the user wants to browse/edit the workspace
  in a full editor.

Don't spin one up unprompted for trivial tasks — offer it when seeing-it beats
telling-it, or when the user asks to look around / pair.
