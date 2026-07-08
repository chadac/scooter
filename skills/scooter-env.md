---
name: scooter-env
type: knowledge
version: 1.0.0
triggers:
- modify environment
- change my environment
- add a tool permanently
- install permanently
- add a service
- enable a service
- nixos module
- modify_environment
- rebuild environment
- persistent tool
- add a package to the environment
---

# Modifying your own environment (modify_environment)

You can change your OWN compute environment at runtime — add tools, packages,
systemd services, or any NixOS config — and have it take effect live, no restart.
You do this with the **`modify_environment`** tool (not by editing files in the
sandbox). The build+switch runs in the BACKGROUND, so you keep working and check
`scooter-env-status` for the result (see "It runs in the BACKGROUND" below).

## When to use it

Use `modify_environment` when a change should be **part of the environment**:
- a tool/package you'll use repeatedly (vs a one-off `nix run`),
- a **systemd service** (a notebook server, a web service, a daemon),
- environment config (env vars, lazy tools, settings).

For a quick one-off, prefer `nix run nixpkgs#<pkg>` (see the nix-dev-env skill).
For something durable, use `modify_environment` — it persists across suspend/
resume and is re-applied if the pod restarts.

## How to use it

Call `modify_environment` with `module_nix` = a **complete NixOS module** (the
same module syntax the nix-dev-env skill describes). Examples:

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

## It runs in the BACKGROUND — keep working, then check the status

`modify_environment` **launches** the build+switch in the background and returns
immediately, so you DON'T block waiting for it (a build can take ~1-3 min). Keep
doing other work. When you need the change, **check on it**:

```bash
scooter-env-status
#   environment: building — the switch is still in progress; check again shortly.
#   environment: done (ready)          ← the new config/tools are live
#   environment: FAILED  (prints the full build/switch log)
```

- **Don't rely on a tool/service you just added until `scooter-env-status` says
  `done`** — it isn't active while the switch is still `building`/`switching`.
- On success you'll also get a system note that the change went live. On failure,
  `scooter-env-status` prints the **full build/switch log** — read the error, fix
  the module, and call `modify_environment` again.
- Only **one** switch runs at a time. If you call `modify_environment` while one is
  still in progress it's refused — wait for `scooter-env-status` to report `done`
  (or `failed`) first.

## What happens (the safety model)

1. Your module is **built** in the sandbox. The build is the validation gate —
   if the module has an error (a typo, an undefined variable, a missing package),
   the build FAILS, nothing changes, and `scooter-env-status` shows the error.
2. On a clean build it's **switched into the running system** live, registered as
   a new generation.
3. If the switch itself fails (a service won't start), it **auto-rolls-back** to
   the previous good config. Your environment is never left broken.

So: iterate freely. A bad module can't brick the sandbox — worst case the switch
fails and the old environment stays (check `scooter-env-status` for the error).
**Prefer lazy tools** (`programs.lazyTools`) over eager `environment.systemPackages`
for anything heavy, so the switch stays fast (builds on first use, not at switch time).
