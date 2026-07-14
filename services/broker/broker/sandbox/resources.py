"""Sandbox resources — the friendly cpu/memory/gpu shape, boundary validation, and
the render step that maps it to the k8s container `resources` block.

Ported from the agent-host's session/resources.ts (the salvaged #128 logic) so the
broker — which now owns sandbox provisioning + the size spec — renders + validates
resource quantities the same way. GPU renders as `nvidia.com/gpu` on BOTH requests
and limits (k8s requires request==limit for extended resources).

The regexes MUST match the agent-host's validateResources (resourceTools.ts still
validates tool INPUT there); keep them identical to avoid drift.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

GPU_RESOURCE = "nvidia.com/gpu"

_CPU_RE = re.compile(r"^\d+m?$")  # "500m", "2"
_MEMORY_RE = re.compile(r"^\d+(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$")  # "1Gi", "512Mi", "2G"

# Platform fallback when no conversation spec + no deployment default apply: spread
# pods across nodes (requests) + OOM-protect the node (mem limit), no cpu limit, no gpu.
PLATFORM_DEFAULT: dict = {
    "requests": {"cpu": "500m", "memory": "1Gi"},
    "limits": {"memory": "4Gi"},
}


class InvalidResource(ValueError):
    """A malformed quantity/count. Carries the offending field for a clear message."""

    def __init__(self, field: str, value: object, message: str):
        self.field = field
        self.value = value
        super().__init__(message)


@dataclass
class SandboxResources:
    """The friendly shape: requests/limits each with optional cpu/memory/gpu."""

    requests: dict | None = None  # {cpu?, memory?, gpu?}
    limits: dict | None = None

    def to_dict(self) -> dict:
        out: dict = {}
        if self.requests:
            out["requests"] = self.requests
        if self.limits:
            out["limits"] = self.limits
        return out

    @staticmethod
    def from_dict(d: dict | None) -> "SandboxResources":
        d = d or {}
        return SandboxResources(requests=d.get("requests"), limits=d.get("limits"))


def validate_resources(r: SandboxResources) -> SandboxResources:
    """Validate at the boundary — a bad quantity must never reach the CR. Returns the
    value on success; raises InvalidResource otherwise."""
    for side_name in ("requests", "limits"):
        q = getattr(r, side_name)
        if not q:
            continue
        cpu = q.get("cpu")
        if cpu is not None and not _CPU_RE.match(str(cpu)):
            raise InvalidResource(f"{side_name}.cpu", cpu, f'invalid cpu quantity "{cpu}"')
        mem = q.get("memory")
        if mem is not None and not _MEMORY_RE.match(str(mem)):
            raise InvalidResource(f"{side_name}.memory", mem, f'invalid memory quantity "{mem}"')
        gpu = q.get("gpu")
        if gpu is not None and (not isinstance(gpu, int) or isinstance(gpu, bool) or gpu < 0):
            raise InvalidResource(f"{side_name}.gpu", gpu, f"invalid gpu count {gpu}")
    return r


def render_resources(r: SandboxResources) -> dict:
    """Friendly -> k8s container `resources` block. cpu/memory pass through; gpu ->
    nvidia.com/gpu on BOTH sides (a gpu on either side sets both). Empty sides omitted."""
    req = r.requests or {}
    lim = r.limits or {}
    gpu = req.get("gpu")
    if gpu is None:
        gpu = lim.get("gpu")

    def side(q: dict) -> dict:
        out: dict = {}
        if q.get("cpu") is not None:
            out["cpu"] = q["cpu"]
        if q.get("memory") is not None:
            out["memory"] = q["memory"]
        if gpu is not None:
            out[GPU_RESOURCE] = str(gpu)
        return out

    block: dict = {}
    rendered_req = side(req)
    rendered_lim = side(lim)
    if rendered_req:
        block["requests"] = rendered_req
    if rendered_lim:
        block["limits"] = rendered_lim
    return block


def resolve_resources(
    conversation: SandboxResources | None, deployment_default: SandboxResources | None
) -> SandboxResources:
    """conversation override -> deployment default -> platform default (never None)."""
    if conversation and conversation.to_dict():
        return conversation
    if deployment_default and deployment_default.to_dict():
        return deployment_default
    return SandboxResources.from_dict(PLATFORM_DEFAULT)
