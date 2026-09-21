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

## Building here: `/homeless-shelter` and why the build aborts near the end

This sandbox runs Nix with **`sandbox = false`** (a container can't nest the
build sandbox). One Nix safety check only fires in that mode, and it looks like a
flaky build:

```
error: home directory "/homeless-shelter" exists; please remove it to assure
purity of builds without sandboxing
```

**What it means.** Nix runs every builder with `HOME=/homeless-shelter`, a path
that is deliberately supposed to NOT exist, so a build that reaches for `$HOME`
fails loudly instead of silently picking up your real dotfiles. With the sandbox
ON, that home is inside the build's private mount namespace and nobody else can
see it. With the sandbox OFF there is only the one real filesystem, so Nix checks
the path before EVERY build and refuses if something created it.

**Why it bites mid-run.** Some builder in the dependency graph (npm, cargo, go —
anything that mkdir's `$HOME`) creates `/homeless-shelter` and leaves it behind.
Every later build in the same run then aborts on the check. So a long
`nix develop` can download and build for ten minutes and fail at the end, and the
error names a directory you never touched. It is not your flake, and not a
network flake.

**The fix.** Remove it and re-run — the store keeps everything already built, so
a retry resumes rather than restarts:

```bash
rm -rf /homeless-shelter
nix develop --no-sandbox -c <command>
```

**When a single `rm` isn't enough** (a builder recreates it partway through), run
a janitor beside the build:

```bash
(while true; do rm -rf /homeless-shelter 2>/dev/null; sleep 0.5; done) & JAN=$!
cd /workspace/<repo>
nix develop --no-sandbox -c <command>
kill $JAN
```

Two traps worth knowing:

- **Background the janitor, not your build.** `cd /repo && (janitor) & ...` binds
  the `&` to the WHOLE `cd && (…)` compound, so the `cd` is what gets
  backgrounded and your build runs from the wrong directory (`error: could not
  find a flake.nix file`). Start the janitor first, then `cd` on its own line.
- Use `run_background` for the build itself — a `nix develop` on a cold store is
  far past the ~5min foreground timeout.

**Don't** "fix" this by setting `sandbox = true` (it can't work here) or by
pointing `HOME` somewhere real for the build — the check is protecting build
purity, and the directory is genuinely garbage left by another builder.

## The same trap, second form: helpers that DROP privileges

`/homeless-shelter` is one instance of a general pattern here: **you are uid 0, and the
nix dev shell puts you in a private `TMPDIR` that only root may enter.** Anything that
drops privileges to do its work then cannot reach its own files.

The one you will actually hit is Postgres, which hard-refuses to run as root, so test
harnesses re-exec it as `nobody`:

```
initdb: error: could not access directory "/tmp/nix-shell.XXXX/pg/data": Permission denied
```

The data dir gets chowned to `nobody` — but its PARENT, the shell's `$TMPDIR`, is mode
700 root-owned, so `nobody` cannot traverse into it. Run the harness with a
world-traversable tmpdir:

```bash
nix develop --no-sandbox -c env TMPDIR=/tmp <the test command>
```

Related: if you SIGKILL such a harness (`kill_background` does), the Postgres it started
**survives** and squats its port, so the next run dies with `pg_ctl: could not start
server` and a log that explains nothing. Reap it before re-running:

```bash
pkill -f "[p]ostgres"; rm -rf /tmp/scooter-e2e-pg-*
```

CI runners are non-root, so none of this reproduces there. It is an artifact of being
root in this sandbox — never a reason to change the harness.
