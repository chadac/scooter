---
name: nix-dev-env
type: knowledge
version: 1.0.0
triggers:
- dev environment
- service
- systemd
- systemctl
- jupyter
- notebook
- uv
- python
- run a server
- start a service
- background service
- port
- lazy tool
- stub
---

# Dev environment (this sandbox)

This sandbox is a **NixOS** dev box with **systemd**. You can build/install tools
on demand, and run real background services. Three things specific to here:

## 1. Common tools are LAZY — just run them

Tools like `uv` are pre-wired as **lazy stubs**: the binary isn't baked into the
image, but running the command builds it from Nix on first use (slow once, then
instant) and caches it. So just:

```bash
uv --version        # builds uv the first time, runs it; later calls are instant
uv pip install ...
```

No `nix profile install` needed for these — they're already on `PATH`.

## 2. Installing other tools with Nix

For anything not pre-wired, use Nix (there is **no** apt/brew/yum here):

```bash
nix profile install nixpkgs#ripgrep    # install onto PATH (~/.nix-profile/bin)
nix run nixpkgs#htop                    # run once without installing
nix search nixpkgs <query>             # find the package name
```

`nixpkgs` is **pinned** to a fixed version, so `nixpkgs#x` is deterministic.
(See also the `nix-packages` skill for list/remove/upgrade.)

## 3. Running services (systemd)

Real background services run as **systemd units**. Start/stop/inspect them:

```bash
systemctl start  <service>            # start a service
systemctl stop   <service>            # stop it
systemctl status <service>            # is it running? recent logs
journalctl -u <service> -f            # follow its logs
```

A service that's defined-but-off is enabled on demand with `systemctl start`.
Once it's listening on a port, that port is reachable inside the sandbox (port-
forwarding to expose it externally is a separate step — ask if you need it).

## Which tools are already lazy

Some tools are STUBS: on `PATH` immediately, fetched for real the first time you
run them, costing the image only their build recipe. Today that set is `uv`,
`tree`, `marimo`, `ttyd`, `code-server`, and `awscli2`. Just run them — the first
call pauses while the tool arrives, and later calls are instant.

The set is declared when the image is built
(`modules/sandbox-os/stubs.nix` in the scooter repo). A module you write in the
sandbox cannot add to it: any other package you install is built or downloaded
then and there, not on first use.
