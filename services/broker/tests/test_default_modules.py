"""Unit test for the deployment-default module tarball (GET /modules/default.tar.gz).

Proves: the endpoint serves a gzipped tar of the `.nix` files in the configured
default-modules dir, UNAUTHENTICATED (the pod fetches it at boot). An unset/empty
dir -> an empty tarball (200, no entries), so the pod boots on baseline.
"""

from __future__ import annotations

import gzip
import io
import os
import tarfile

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.config import refresh_settings  # noqa: E402
from broker.core.app import create_app  # noqa: E402


def _client() -> TestClient:
    refresh_settings()
    return TestClient(create_app())


def _entries(body: bytes) -> dict[str, str]:
    raw = gzip.decompress(body)
    out = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r") as tar:
        for m in tar.getmembers():
            out[m.name] = tar.extractfile(m).read().decode()
    return out


def test_tarball_has_each_default_nix_file(monkeypatch, tmp_path):
    (tmp_path / "alpha.nix").write_text('{ ... }: { environment.etc."a".text = "a"; }')
    (tmp_path / "beta.nix").write_text('{ ... }: { environment.etc."b".text = "b"; }')
    # A non-.nix file MUST be ignored.
    (tmp_path / "README.md").write_text("ignore me")
    monkeypatch.setenv("SANDBOX_DEFAULT_MODULES_DIR", str(tmp_path))

    resp = _client().get("/modules/default.tar.gz")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/gzip"
    entries = _entries(resp.content)
    assert set(entries) == {"alpha.nix", "beta.nix"}
    assert entries["alpha.nix"] == '{ ... }: { environment.etc."a".text = "a"; }'
    assert entries["beta.nix"] == '{ ... }: { environment.etc."b".text = "b"; }'


def test_unset_dir_is_empty_tarball(monkeypatch):
    monkeypatch.delenv("SANDBOX_DEFAULT_MODULES_DIR", raising=False)
    resp = _client().get("/modules/default.tar.gz")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/gzip"
    assert _entries(resp.content) == {}


def test_missing_dir_is_empty_tarball(monkeypatch, tmp_path):
    monkeypatch.setenv("SANDBOX_DEFAULT_MODULES_DIR", str(tmp_path / "does-not-exist"))
    resp = _client().get("/modules/default.tar.gz")
    assert resp.status_code == 200
    assert _entries(resp.content) == {}


def test_endpoint_is_unauthenticated(monkeypatch, tmp_path):
    # No auth header at all -> still 200 (the pod fetches at boot, pre-identity).
    (tmp_path / "only.nix").write_text("{ ... }: { }")
    monkeypatch.setenv("SANDBOX_DEFAULT_MODULES_DIR", str(tmp_path))
    resp = _client().get("/modules/default.tar.gz")
    assert resp.status_code == 200
    assert set(_entries(resp.content)) == {"only.nix"}
