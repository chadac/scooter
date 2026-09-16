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

Your sandbox runs with a fixed CPU + memory size, set by your deployment —
`show_sandbox_resources` reports the actual numbers, and the platform's own fallback
is `cpu: 2`, `memory: 4Gi`. **Whatever the value, requests == limits (Guaranteed
QoS).** That means the size is a HARD cap: you are throttled at your CPU limit and
**OOM-killed** past your memory limit. It also means you can't "borrow" spare
capacity from the node — you get
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
size back down to the default your deployment reports so you're not holding a big
reservation idle. Bigger sandboxes are more expensive and reduce how many can be
packed on a node.

## How

1. `show_sandbox_resources` — see what you currently have.
2. `set_sandbox_resources` — use a **named preset** (easiest) OR set raw cpu/memory/gpu fields.

### Named presets (recommended)

**The preset table is per-deployment** — an operator defines it in kubenix
(`agentSandbox.sandboxSizes`), and a deployment may offer none at all. So there are
no preset names to memorise, and **this skill deliberately doesn't list any**: any
table here would be a guess about your cluster.

**Ask, don't guess.** `show_sandbox_resources` reports the presets this deployment
actually offers, each with its cpu/memory/gpu, the deployment's own guidance for when
to pick it, and which one is the default. Read that, then pass the name:

```
show_sandbox_resources()             # → the presets available HERE
set_sandbox_resources(size="<name>") # one of those names
```

If a name isn't offered, the error lists the valid ones — that error is the
authority, not any documentation. If `show_sandbox_resources` reports no presets,
this deployment hasn't configured any: use raw resources (below).

A deployment may also offer **GPU presets**. A preset is the ONLY way to get a GPU
by name — there is no "add a GPU to my current size" operation, because a GPU count
must match on requests and limits.

When the heavy phase is done, set the size back to the default that
`show_sandbox_resources` names, so you're not holding a big reservation idle.

### Raw resources (advanced)

You can also set raw quantities (cpu `"2"` / `"500m"`, memory `"16Gi"` / `"512Mi"`,
gpu a whole number). Omit a field to keep it. Keep requests == limits for Guaranteed QoS.

```
set_sandbox_resources(requestCpu="8", limitCpu="8", requestMemory="32Gi", limitMemory="32Gi")
```

Prefer a preset when one fits. A raw size shows in the UI's Sandbox tab as **Custom**
rather than a named size, and it can land outside what the cluster can actually
schedule — the preset table is what the operator has confirmed is available.
