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

## 1. Python: use `uv` — it is patched for Nix

`uv` is on `PATH` and is **uv-nix**, not stock uv. It patches wheels and the
Python interpreters it downloads to link against Nix-supplied libraries, so the
usual NixOS failure — a wheel that installs fine then dies on import with a
missing `libstdc++`/BLAS, or a downloaded CPython that won't exec at all — does
not happen:

```bash
uv venv && uv add numpy scipy matplotlib   # these import; no LD_LIBRARY_PATH
uv run script.py
```

So reach for `uv` before hand-rolling a venv or hunting for a nixpkgs Python
package set. If you write a module whose service runs uv, reference
`config.sandboxOs.uv.package` — **`pkgs.uv` is the vanilla one** and puts the
import failures back.

Other tools are pre-wired as **lazy stubs**: on `PATH`, but built from Nix on
first call (slow once, then instant). Just run them — no `nix profile install`.

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
run them, costing the image only their build recipe. Today that set is `tree`,
`marimo`, `ttyd`, `code-server`, and `awscli2`. Just run them — the first call
pauses while the tool arrives, and later calls are instant.

`uv` is NOT in that set: it is baked whole, because the sandbox ships uv-nix
rather than nixpkgs' uv (see §1). It never pauses on first call.

The set is declared when the image is built
(`modules/sandbox-os/stubs.nix` in the scooter repo). A module you write in the
sandbox cannot add to it: any other package you install is built or downloaded
then and there, not on first use.
