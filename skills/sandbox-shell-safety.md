---
name: sandbox-shell-safety
type: knowledge
version: 1.0.0
triggers:
- grep
- find
- search the filesystem
- search for a file
- where is
- locate
- tree
- long command
- build
- test suite
- slow command
- command timed out
- times out
---

# Running shell commands safely in this sandbox

Your sandbox is a **NixOS** box, so its filesystem is shaped differently from a
normal Linux host. A few command patterns will hang or waste minutes here — this
skill is how to avoid them.

## Never scan the whole filesystem

`/nix/store` holds **tens of thousands** of package paths (the entire OS + every
tool's dependencies). A recursive search from `/` walks all of it and effectively
never finishes:

```bash
# BAD — scans /nix/store, runs for many minutes, will be KILLED at the timeout:
grep -rln "some text" /
find / -name "*.tf"
```

Note: piping to `| grep -v /nix` only filters the *output* — it does NOT stop the
traversal. **Scope the search to where your work actually is:**

```bash
# GOOD — search your workspace (or a specific repo), not the whole disk:
grep -rln "some text" /workspace
grep -rln "some text" .            # cwd starts at /workspace
find /workspace -name "*.tf"
rg "some text"                     # ripgrep respects .gitignore + skips /nix by default
```

Your work lives under **`/workspace`**. Start searches there unless you have a
specific reason to look elsewhere — and never at `/`.

## Long commands: run them in the BACKGROUND

A shell command that runs more than a few seconds **blocks your whole turn** and
is **killed after a hard timeout (~5 min)**. For a build, a test suite, or any
long job, use the `run_background` tool instead — it detaches the command, returns
a job id immediately, and lets you keep working:

```
run_background("npm run build")      # returns a job id; keeps running
check_background("<job id>")         # poll its status + output tail later
```

If a command DID time out, you'll see a message telling you so — don't just retry
it verbatim. **Narrow it** (scope the path, add a filter) or move it to
`run_background`.

## Do not use the `tree` or `read_image` tools

Those two tools read a **different machine's filesystem**, not your sandbox — their
output is misleading and has confused past runs. To explore directories, use the
`shell` tool with `ls`, `ls -R`, or `find` (scoped to `/workspace`) — those run in
your sandbox and see the real workspace.
