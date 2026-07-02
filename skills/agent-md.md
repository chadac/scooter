---
name: agent-md
type: knowledge
version: 1.0.0
triggers:
- start working
- clone a repo
- cloned the repo
- cd into
- working in a repo
- project conventions
- coding conventions
- AGENTS.md
- CLAUDE.md
- repo instructions
- house style
---

# Read the repo's AGENTS.md / CLAUDE.md FIRST

Many repositories ship an **`AGENTS.md`** (or **`CLAUDE.md`**) at their root — a
file written specifically for a coding agent: build/test commands, conventions,
gotchas, "always do X", "never touch Y". It is the single most useful context for
working in that repo. Your sandbox mounts the workspace at `/workspace`, and goose
can't auto-discover these files (it runs outside the sandbox), so **you must read
them yourself.**

## When

As soon as you start working in a repository or directory — right after you clone
or `cd` into it, and before you make changes — check for and read the guidance
file:

```bash
# from the repo root (or wherever you're working):
for f in AGENTS.md CLAUDE.md .goosehints; do
  [ -f "$f" ] && { echo "=== $f ==="; cat "$f"; }
done
```

These conventions **cascade**: a file in a subdirectory refines the one above it.
If you `cd` into a subpackage that has its own `AGENTS.md`, read that too — the
nearest file wins for anything it covers. A quick way to find them all on your
path:

```bash
# nearest-first: cwd up to the repo root
d=$(pwd); while [ "$d" != "/" ]; do
  for f in "$d/AGENTS.md" "$d/CLAUDE.md"; do [ -f "$f" ] && echo "$f"; done
  d=$(dirname "$d")
done
```

## Then

**Follow what it says.** Treat the repo's `AGENTS.md`/`CLAUDE.md` as binding
instructions for that repo — its build/test/lint commands, its commit and PR
conventions, its "do/don't" rules — the same way you follow these skills. If it
conflicts with a general habit of yours, the repo's file wins inside that repo.

Re-read the nearest file when you switch to a different repo or a subpackage that
has its own — don't assume the last one still applies.
