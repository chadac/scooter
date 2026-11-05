"""The skills provider: the skill-source store and its routes."""

from __future__ import annotations

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

from .config import SkillsSettings
from .store import SkillSourceStore
from .transport import SkillSources


@register_provider
def skills(ctx: BrokerContext) -> Provider:
    transport = SkillSources()
    if not SkillsSettings().skills_enabled or ctx.owners is None:
        return Provider(name="skills", transports=[transport], enabled=False)
    transport.store = SkillSourceStore(ctx.contrib_store_config("skills"))
    transport.owners = ctx.owners
    return Provider(name="skills", transports=[transport], enabled=True)
