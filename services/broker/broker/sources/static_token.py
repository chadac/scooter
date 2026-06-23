"""Static token credential source — a PAT / bot token from config."""

from __future__ import annotations

from dataclasses import dataclass

from ..core.types import Credential, CredentialSource, Identity


@dataclass
class StaticTokenSource(CredentialSource):
    token: str
    kind: str = "bearer"               # "bearer" | "header"
    header_name: str | None = None     # for kind="header" (e.g. PRIVATE-TOKEN)

    async def get(self, identity: Identity) -> Credential:
        meta = {"header_name": self.header_name} if self.header_name else {}
        return Credential(kind=self.kind, value=self.token, meta=meta)
