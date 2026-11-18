"""generate_image: the agent's one tool for making or editing an image.

Built once per provider build (`build_generate_image_tool`), closing over this
deployment's enabled backends, their manifests and the chosen selector, so both
the tool's description and its fallthrough behavior come from what is actually
configured rather than a static docstring.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

import jsonschema

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from .manifest import Backend, BackendManifest, GenerateRequest, ModelManifest
from .sandbox_io import SandboxIOError, read_reference_image, write_image
from .selectors import BackendCandidate, Selector, Usage
from .store import GenerationStore

logger = logging.getLogger(__name__)


def _describe_model(model: ModelManifest) -> str:
    props = model.params_schema.get("properties", {})
    param_list = ", ".join(sorted(props)) if props else "none"
    return f"    - `{model.name}` — {model.description or 'no description.'} params: {param_list}"


def _describe_backend(name: str, manifest: BackendManifest) -> str:
    lines = [f"  - `{name}`:"]
    lines.extend(_describe_model(m) for m in manifest.models)
    return "\n".join(lines)


def build_description(backend_configs: dict[str, dict], backends: dict[str, Backend], daily_limit: int) -> str:
    sections = "\n".join(_describe_backend(name, backends[name].manifest) for name in sorted(backend_configs))
    return (
        "Generate or edit an image with an external image model and save it into your "
        "sandbox under /workspace/images/, returning the saved path(s) so you can "
        "`view_image` what was made.\n\n"
        f"You are capped at {daily_limit} images per day, counted across every backend.\n\n"
        "Backends and the models each offers:\n"
        f"{sections}\n\n"
        "Pass `backend` and/or `model` to pick one yourself — naming a backend makes it "
        "the ONLY candidate, so a request that doesn't fit never silently falls through to "
        "another. Leave both unset to let the deployment choose. `params` is validated "
        "against the chosen model's schema above; a mismatch is rejected with that schema "
        "echoed back in the error so you can fix it."
    )


def _candidates(backend_configs: dict[str, dict]) -> list[BackendCandidate]:
    return [
        BackendCandidate(
            name=name,
            priority=int(cfg.get("priority", 100)),
            daily_limit=cfg.get("dailyLimit"),
        )
        for name, cfg in backend_configs.items()
    ]


def build_generate_image_tool(
    mcp: Any,
    *,
    backends: dict[str, Backend],
    backend_configs: dict[str, dict],
    selector: Selector,
    selector_name: str,
    store: GenerationStore,
    daily_limit: int,
    agent_host_url: str,
) -> None:
    all_candidates = _candidates(backend_configs)

    async def generate_image(
        prompt: str,
        backend: str | None = None,
        model: str | None = None,
        params: dict[str, Any] | None = None,
        n: int = 1,
        reference_image_path: str | None = None,
        out_path: str | None = None,
        ctx: ToolContext = ToolContextDep,
    ) -> ToolResult:
        params = params or {}
        user_id = ctx.identity.owner or ctx.identity.conversation_id
        conversation_id = ctx.identity.conversation_id

        if backend is not None:
            if backend not in backend_configs:
                available = ", ".join(sorted(backend_configs)) or "(none configured)"
                return ToolResult.error(f"Unknown or disabled backend {backend!r}. Available: {available}.")
            pool = [c for c in all_candidates if c.name == backend]
        else:
            pool = all_candidates

        if not pool:
            return ToolResult.error("No image backend is configured on this deployment.")

        usage_row = await store.usage_today(user_id)
        usage = Usage(total=usage_row.total, total_limit=daily_limit, per_backend=usage_row.per_backend)

        try:
            ordered = list(selector(GenerateRequest(prompt=prompt, model=model or "", params=params, n=n), pool, usage))
        except Exception as e:
            logger.exception("selector %r raised", selector_name)
            return ToolResult.error(f"Backend selection ({selector_name!r}) failed: {e}")

        if not ordered:
            return ToolResult.error(
                f"No backend available for you right now — you are at your daily cap "
                f"({usage.total}/{daily_limit} images today), or over a per-backend cap."
            )

        reference_bytes: bytes | None = None
        if reference_image_path:
            try:
                reference_bytes = await read_reference_image(agent_host_url, conversation_id, reference_image_path)
            except SandboxIOError as e:
                return ToolResult.error(f"Could not read reference_image_path {reference_image_path!r}: {e}")

        single_candidate = backend is not None
        errors: list[str] = []
        for candidate in ordered:
            impl = backends[candidate.name]
            chosen_model = impl.manifest.model(model) if model else impl.manifest.default_model
            if chosen_model is None:
                available = ", ".join(m.name for m in impl.manifest.models)
                msg = f"{candidate.name} has no model {model!r} (has: {available})."
                if single_candidate:
                    return ToolResult.error(msg)
                errors.append(msg)
                continue

            validator = jsonschema.Draft7Validator(chosen_model.params_schema)
            violations = sorted(err.message for err in validator.iter_errors(params))
            if violations:
                msg = (
                    f"{candidate.name}/{chosen_model.name}: params do not match its schema:\n"
                    + "\n".join(f"  - {v}" for v in violations)
                    + f"\nschema:\n{chosen_model.params_schema}"
                )
                if single_candidate:
                    return ToolResult.error(msg)
                errors.append(msg)
                continue

            request = GenerateRequest(
                prompt=prompt, model=chosen_model.name, params=params, n=n, reference_image=reference_bytes
            )
            try:
                images = await impl.generate(request)
            except Exception as e:
                logger.exception("backend %r failed", candidate.name)
                msg = f"{candidate.name}/{chosen_model.name} failed: {e}"
                if single_candidate:
                    return ToolResult.error(msg)
                errors.append(msg)
                continue

            try:
                paths = [
                    await write_image(
                        agent_host_url, conversation_id, _image_name(out_path, i, len(images), data), data
                    )
                    for i, data in enumerate(images)
                ]
            except SandboxIOError as e:
                # The image was made but could not be delivered; do not record usage for a
                # generation the agent cannot see, and do not retry another backend for it.
                return ToolResult.error(f"{candidate.name} generated the image but it could not be saved: {e}")

            await store.record(user_id, candidate.name, chosen_model.name)
            return ToolResult.ok(
                f"Generated {len(paths)} image(s) with {candidate.name}/{chosen_model.name}:\n"
                + "\n".join(f"- {p}" for p in paths)
            )

        detail = "\n".join(f"- {e}" for e in errors) if errors else "(no candidate backend was tried)"
        return ToolResult.error(f"Every candidate backend failed or rejected the request:\n{detail}")

    mcp.tool(
        generate_image,
        name="generate_image",
        description=build_description(backend_configs, backends, daily_limit),
    )


def _image_name(out_path: str | None, index: int, total: int, data: bytes) -> str:
    """The filename to save image `index` of `total` under, honoring `out_path` as a hint."""
    if total == 1:
        return out_path or f"{uuid4().hex}.{_extension(data)}"
    if not out_path:
        return f"{uuid4().hex}-{index}.{_extension(data)}"
    stem, _, ext = out_path.rpartition(".")
    return f"{stem or out_path}-{index}.{ext}" if ext else f"{out_path}-{index}"


def _extension(data: bytes) -> str:
    """The file extension for the image bytes' format (backends differ: PNG, JPEG, WebP)."""
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return "png"
