---
name: scooter-compute-scaling
type: knowledge
version: 1.0.0
triggers:
- heavy build
- large build
- compile
- run the tests
- big test suite
- out of memory
- OOM
- killed
- process killed
- ran out of memory
- slow build
- this is slow
- need more memory
- need more cpu
- more compute
- scale up
- resize my sandbox
- large model
- big dataset
- data processing
- train a model
- parallel build
- make -j
- cargo build
- nix build
---

# Scale your sandbox's compute BEFORE heavy work (anticipate, don't react)

Your sandbox runs with a fixed CPU + memory size. **By default you start at the
`medium` preset: `cpu: 2`, `memory: 4Gi`, with requests == limits (Guaranteed QoS).**
That means the size is a HARD cap: you are throttled at 2 CPU and **OOM-killed**
past 4Gi. It also means you can't "borrow" spare capacity from the node — you get
exactly what you reserved, and so does everyone else (that isolation is deliberate:
it stops one runaway sandbox from starving its neighbours).

So if you're about to do something heavy, **size up first**. Don't wait to get
killed and retry.

## The one thing that makes this a "before" skill

`set_sandbox_resources` **records** a new size that takes effect on the **NEXT
sandbox restart** — it does NOT resize the pod you're running in right now. So a
resize you request in the middle of a build does nothing for that build. The value
is entirely in *anticipating*: set the size, let the sandbox pick it up on its next
restart (an idle suspend→resume, or tell the user a restart is needed), then run
the heavy work.

## When to scale UP (before you start)

Estimate the peak, then size for it:

- **Large `nix build` / cargo / a big `make -j`** — parallel compiles are both
  CPU- and memory-hungry. Bump `cpu` to 4–8 and `memory` to 8–16Gi.
- **A big test suite** run in parallel — more workers need more of both.
- **A large model, big dataset, or data processing** (pandas/polars/numpy on GBs,
  local inference) — memory is usually the killer here; size `memory` to comfortably
  hold the working set (e.g. 16–32Gi) so you aren't OOM-killed mid-run.
- **GPU work** — request whole GPUs via `limitGpu` / `requestGpu` (they render on
  both sides automatically; k8s requires request == limit for GPUs).

If you already got **`Killed` / an OOM** on a task, that's the signal your memory
cap was too low: raise `memory`, restart, retry — don't just re-run at the same size.

## When to scale DOWN

When a heavy phase is done and the conversation goes back to light editing/chat,
size back toward the default (`medium`: `cpu: 2`, `memory: 4Gi`) so you're not
holding a big reservation idle. Bigger sandboxes are more expensive and reduce how
many can be packed on a node.

## How

1. `show_sandbox_resources` — see what you currently have.
2. `set_sandbox_resources` — use a **named preset** (easiest) OR set raw cpu/memory/gpu fields.

### Named presets (recommended)

Most deployments offer these standard presets (requests == limits for Guaranteed QoS):

- **`tiny`**: 250m CPU, 256Mi memory — minimal for light editing
- **`small`**: 1 CPU, 2Gi memory — small builds, scripting
- **`medium`**: 2 CPU, 4Gi memory — **the default**
- **`large`**: 4 CPU, 16Gi memory — parallel builds, heavy compute

Pass the preset name to `set_sandbox_resources`:

```
set_sandbox_resources(size="large")
```

Then let the sandbox restart pick it up, and start the build. When you're done:

```
set_sandbox_resources(size="medium")
```

### Raw resources (advanced)

You can also set raw quantities (cpu `"2"` / `"500m"`, memory `"16Gi"` / `"512Mi"`,
gpu a whole number). Omit a field to keep it. Keep requests == limits for Guaranteed QoS.

```
set_sandbox_resources(requestCpu="8", limitCpu="8", requestMemory="32Gi", limitMemory="32Gi")
```
