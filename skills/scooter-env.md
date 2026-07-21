---
name: scooter-env
type: knowledge
version: 2.0.0
triggers:
- modify environment
- change my environment
- add a tool permanently
- install permanently
- add a service
- enable a service
- nixos module
- scooter-rebuild
- rebuild environment
- persistent tool
- add a package to the environment
---

# Modifying your own environment (scooter-rebuild)

You can change your OWN compute environment — add tools, packages, systemd
services, or any NixOS config — and have it take effect live, no restart. You do
this by **editing NixOS module files under `/etc/scooter/modules/` and running
`scooter-rebuild switch`**. (There is no `modify_environment` tool — the CLI is the
interface.)

Your modules live in `/etc/scooter/modules/*.nix` on the workspace PVC, so they're
durable — they persist across suspend/resume and are re-applied if the pod restarts.

## When to use it

Use a module when a change should be **part of the environment**:
- a tool/package you'll use repeatedly (vs a one-off `nix run`),
- a **systemd service** (a notebook server, a web service, a daemon),
- environment config (env vars, lazy tools, settings).

For a quick one-off, prefer `nix run nixpkgs#<pkg>` (see the nix-dev-env skill). For
something durable, author a module and `scooter-rebuild switch`.

## The workflow

```bash
scooter-rebuild module new mytools     # create /etc/scooter/modules/mytools.nix (template)
scooter-rebuild module edit mytools    # edit it in $EDITOR
# ... or just write /etc/scooter/modules/mytools.nix directly ...
scooter-rebuild switch                 # build + switch to the new config (background)
scooter-rebuild status                 # check the result (see "background" below)

scooter-rebuild module list            # list your modules
scooter-rebuild module show mytools    # print one
scooter-rebuild module rm  mytools     # delete one (then switch)
```

A module is a **NixOS module** (the same syntax the nix-dev-env skill describes).
Examples of what to put in `/etc/scooter/modules/<name>.nix`:

Add packages to PATH:
```nix
{ pkgs, ... }: {
  environment.systemPackages = [ pkgs.ripgrep pkgs.jq ];
}
```

Add a lazy tool (builds on first call — light, no eager build at switch time;
PREFER this for heavy tools):
```nix
{ ... }: {
  programs.lazyTools.tools.htop = { package = "htop"; };
}
```

Enable a background systemd service:
```nix
{ pkgs, ... }: {
  systemd.services.my-server = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8000";
  };
}
```

## Sharing modules via the registry

You can attach modules others published, and publish your own:

```bash
scooter-rebuild module search [query]        # search the shared registry
scooter-rebuild module add <name-or-id>      # attach a registry module (+ switch)
scooter-rebuild module detach <name-or-id>   # detach it (+ switch)
scooter-rebuild module attached              # list attached registry modules
scooter-rebuild publish <name> [--public] [--description D]
                                             # publish your local modules/<name>.nix
```

## It runs in the BACKGROUND — keep working, then check the status

`scooter-rebuild switch` launches the build+switch in the background and returns
immediately, so you DON'T block waiting (a build can take ~1-3 min). Keep doing
other work. When you need the change, **check on it**:

```bash
scooter-rebuild status
#   building — the switch is still in progress; check again shortly.
#   ready    — the new config/tools are live
#   failed   — run `scooter-rebuild status --log` for the full build/switch log
```

- **Don't rely on a tool/service you just added until `scooter-rebuild status` says
  `ready`** — it isn't active while the switch is still building/switching.
- On failure, `scooter-rebuild status --log` prints the **full build/switch log** —
  read the error, fix the module, and `scooter-rebuild switch` again.
- Only **one** switch runs at a time. If you `switch` while one is still in progress
  it's refused — wait for `scooter-rebuild status` to report `ready` (or `failed`).

## What happens (the safety model)

1. Your module is **built** in the sandbox. The build is the validation gate — if
   the module has an error (a typo, an undefined variable, a missing package), the
   build FAILS, nothing changes, and `scooter-rebuild status` shows the error.
2. On a clean build it's **switched into the running system** live, registered as a
   new generation.
3. If the switch itself fails (a service won't start), it **auto-rolls-back** to the
   previous good config. Your environment is never left broken.

So: iterate freely. A bad module can't brick the sandbox — worst case the switch
fails and the old environment stays (check `scooter-rebuild status` for the error).
**Prefer lazy tools** (`programs.lazyTools`) over eager `environment.systemPackages`
for anything heavy, so the switch stays fast (builds on first use, not at switch time).
