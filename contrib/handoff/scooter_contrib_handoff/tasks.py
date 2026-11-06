"""handoff-index: the system task that runs one search-index pass in the broker."""

from __future__ import annotations

from scooter_task import TaskContext, task


@task(name="handoff-index")
async def main(ctx: TaskContext) -> None:
    """Fold changed shared conversations into search."""
    r = await ctx.scooter.broker.post("/handoff/system/index")
    r.raise_for_status()
    ctx.log.info("index pass", extra=r.json())
