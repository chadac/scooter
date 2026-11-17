"""File token credential source: a token re-read from a file, such as a mounted Secret, on every request."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..types import Credential, CredentialSource, Identity


@dataclass
class FileTokenSource(CredentialSource):
    """A token kept current outside the broker, applied without a restart once kubelet updates the mount."""

    path: Path
    kind: str = "bearer"               # "bearer" | "header" | "basic"
    header_name: str | None = None     # for kind="header"

    async def get(self, identity: Identity, request=None) -> Credential:
        try:
            token = self.path.read_text().strip()
        except OSError:
            token = ""
        if not token:
            # Inject nothing rather than an empty `Bearer `, which httpx rejects (a 502);
            # the upstream's own 401 tells the agent the credential is missing.
            return Credential(kind="none", value="")
        meta = {"header_name": self.header_name} if self.header_name else {}
        return Credential(kind=self.kind, value=token, meta=meta)
