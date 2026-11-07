"""The files viewer's contract: path confinement, proxy-prefix routing, renderers.

The viewer is reached through the agent-host proxy at /c/<id>/files/ with the
prefix NOT stripped, so "does it route under a base path" is as much a part of the
contract as what it returns. These tests therefore drive a real server over a real
socket rather than calling the handler's methods.
"""

from __future__ import annotations

import contextlib
import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

import server  # noqa: E402


# --- fixtures -------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace with one of everything the renderers branch on."""
    (tmp_path / "README.md").write_text("# hello\n\nsome prose\n")
    (tmp_path / "main.py").write_text("print('hi')\n")
    (tmp_path / "blob.bin").write_bytes(b"\x00\x01\x02" * 100)
    (tmp_path / ".hidden").write_text("secret-ish\n")
    (tmp_path / "node_modules").mkdir()
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    (repo / "a.txt").write_text("a\n")
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("not in the workspace\n")
    return tmp_path


@pytest.fixture
def static(tmp_path_factory) -> Path:
    """A built frontend as `npm run build` lays it out: index.html beside its assets."""
    dist = tmp_path_factory.mktemp("dist")
    (dist / "index.html").write_text(
        '<script>window.__BASE__ = "{{BASE}}";'
        ' window.__CONVERSATION_URL__ = "{{CONVERSATION_URL}}";</script>'
        '<script type="module" src="{{BASE}}/static/index-abc123.js"></script>'
    )
    (dist / "index-abc123.js").write_text("/* app */\n")
    return dist


@pytest.fixture
def cfg(workspace: Path, static: Path) -> "server.Config":
    return server.Config(root=workspace, base="/c/conv-test/files", port=0, static=static)


@contextlib.contextmanager
def running(cfg: "server.Config"):
    """A live viewer for one config; yields a getter of (status, body)."""
    httpd = server.make_server(cfg)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def get(path: str, base: bool = True):
        prefix = cfg.base if base else ""
        url = f"http://127.0.0.1:{port}{prefix}{path}"
        try:
            with urllib.request.urlopen(url) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def get_json(path: str, **kw):
        status, body = get(path, **kw)
        return status, json.loads(body)

    get.json = get_json
    get.url = lambda path: f"http://127.0.0.1:{port}{cfg.base}{path}"
    try:
        yield get
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def client_for():
    """Factory for a viewer with a config other than the default fixture's."""
    return running


@pytest.fixture
def client(cfg):
    """A live viewer; returns (status, body) for a path appended to the base."""
    with running(cfg) as get:
        yield get


# --- path confinement -----------------------------------------------------------


@pytest.mark.parametrize("escape", ["..", "../outside.txt", "repo/../../outside.txt"])
def test_resolve_refuses_paths_outside_the_root(cfg, escape: str) -> None:
    # Not a trust boundary — whoever reaches this has a terminal on the same pod —
    # but a viewer that can be walked up to / turns every stray ../ into a 200.
    with pytest.raises(ValueError):
        server.resolve(cfg.root, escape)


@pytest.mark.parametrize("absolute", ["/etc/passwd", "//etc/passwd"])
def test_absolute_paths_are_read_as_workspace_relative(cfg, absolute: str) -> None:
    # Every path in this API is workspace-relative, so a leading slash is the
    # workspace root and not the host's. Reinterpreting beats rejecting: the UI
    # builds paths by joining, and a stray slash should resolve, not 400.
    assert server.resolve(cfg.root, absolute) == cfg.root / "etc" / "passwd"


def test_a_host_path_that_exists_outside_the_workspace_is_still_a_404(client) -> None:
    status, payload = client.json("/api/file?path=/etc/passwd")
    assert status == 404, payload


def test_resolve_accepts_the_root_itself_and_children(cfg) -> None:
    assert server.resolve(cfg.root, "") == cfg.root
    assert server.resolve(cfg.root, "repo/a.txt") == cfg.root / "repo" / "a.txt"


def test_escaping_request_is_refused_over_http(client) -> None:
    status, payload = client.json("/api/file?path=../outside.txt")
    assert status == 400, payload


# --- routing under the proxy prefix ---------------------------------------------


def test_routes_are_resolved_under_the_proxy_base(client) -> None:
    # The agent-host does NOT strip /c/<id>/files, so the server must.
    status, payload = client.json("/api/health")
    assert status == 200 and payload["ok"] is True


def test_base_path_is_required_when_configured(client) -> None:
    # A request that skips the prefix is not this service's traffic.
    status, _ = client("/api/health", base=False)
    assert status == 404


def test_index_is_served_at_the_base_root_with_its_base_injected(client, cfg) -> None:
    status, body = client("/")
    assert status == 200
    text = body.decode()
    assert "{{BASE}}" not in text, "the page must not ship its placeholder"
    assert cfg.base in text, "the page cannot know its own prefix; it must be injected"


@pytest.mark.parametrize(
    ("url", "shown"),
    [
        ("https://scooter.example.com/?thread=abc", "https://scooter.example.com/?thread=abc"),
        ("", ""),
        ("javascript:alert(1)", ""),
        ('https://x/"</script><script>alert(1)//', ""),
        ("https://x/\\u0022", ""),
    ],
)
def test_index_links_back_to_its_conversation(workspace: Path, static: Path, url: str, shown: str) -> None:
    cfg = server.Config(root=workspace, base="/c/abc/files", port=0, static=static, conversation_url=url)
    with running(cfg) as get:
        _, body = get("/")
    assert f'window.__CONVERSATION_URL__ = "{shown}";' in body.decode()


def test_unknown_route_is_a_404(client) -> None:
    status, payload = client.json("/api/nope")
    assert status == 404 and "error" in payload


# --- listing --------------------------------------------------------------------


def test_listing_puts_directories_first_and_flags_repos_and_skips(client) -> None:
    status, payload = client.json("/api/list?path=")
    assert status == 200
    names = [e["name"] for e in payload["entries"]]
    kinds = [e["kind"] for e in payload["entries"]]
    assert kinds == sorted(kinds, key=lambda k: k != "dir"), names

    by_name = {e["name"]: e for e in payload["entries"]}
    assert ".hidden" not in by_name, "dotfiles are noise in a review view"
    assert by_name["repo"]["repo"] is True
    assert by_name["node_modules"]["skip"] is True
    assert by_name["README.md"]["size"] == len("# hello\n\nsome prose\n")


def test_listing_a_file_is_a_400_not_a_crash(client) -> None:
    status, payload = client.json("/api/list?path=README.md")
    assert status == 400 and "directory" in payload["error"]


def test_listing_a_missing_path_is_a_404(client) -> None:
    status, payload = client.json("/api/list?path=nope")
    assert status == 404


# --- file renderers -------------------------------------------------------------


def test_source_file_uses_the_code_renderer(client) -> None:
    status, payload = client.json("/api/file?path=main.py")
    assert status == 200
    assert payload["renderer"] == "code"
    assert payload["body"] == "print('hi')\n"
    assert payload["lines"] == 2


def test_an_unchanged_file_is_a_304_and_a_changed_one_is_served(client, workspace: Path) -> None:
    _, first = client.json("/api/file?path=README.md")
    ask = lambda: urllib.request.urlopen(
        urllib.request.Request(client.url("/api/file?path=README.md"), headers={"if-none-match": f'"{first["etag"]}"'})
    )
    with pytest.raises(urllib.error.HTTPError) as caught:
        ask()
    assert caught.value.code == 304
    (workspace / "README.md").write_text("# edited\n")
    with ask() as resp:
        assert json.loads(resp.read())["body"] == "# edited\n"


@pytest.mark.parametrize("name", ["README.md", "NOTES.markdown"])
def test_markdown_gets_its_own_renderer(client, workspace: Path, name: str) -> None:
    # Markdown is parsed in the browser, where the sanitizer is; the server's whole
    # job here is to say which of the page's renderers the body belongs to.
    (workspace / name).write_text("# hi\n")
    _, payload = client.json(f"/api/file?path={name}")
    assert payload["renderer"] == "markdown"


@pytest.mark.parametrize("name", ["report.html", "page.HTM"])
def test_html_gets_its_own_renderer_with_its_source(client, workspace: Path, name: str) -> None:
    html = "<!doctype html><p>hi</p>\n"
    (workspace / name).write_text(html)
    _, payload = client.json(f"/api/file?path={name}")
    assert payload["renderer"] == "html"
    assert payload["body"] == html and payload["etag"]


def test_binary_is_reported_not_rendered(client) -> None:
    _, payload = client.json("/api/file?path=blob.bin")
    assert payload["renderer"] == "binary"
    assert payload["body"] == ""
    assert payload["size"] == 300


def test_a_file_past_the_read_cap_is_metadata_only(client, workspace: Path) -> None:
    (workspace / "huge.log").write_bytes(b"x" * (server.MAX_READ_BYTES + 1))
    _, payload = client.json("/api/file?path=huge.log")
    assert payload["renderer"] == "too-large"
    assert payload["body"] == ""


def test_reading_a_directory_is_a_400(client) -> None:
    status, payload = client.json("/api/file?path=repo")
    assert status == 400 and "file" in payload["error"]


def test_invalid_utf8_is_replaced_rather_than_failing_the_request(
    client, workspace: Path
) -> None:
    (workspace / "latin.txt").write_bytes("café\n".encode("latin-1"))
    status, payload = client.json("/api/file?path=latin.txt")
    assert status == 200 and payload["renderer"] == "code"
    assert "�" in payload["body"]


# --- raw bytes for rendered documents -------------------------------------------


def test_raw_serves_an_image_with_its_content_type(client, workspace: Path) -> None:
    # <img src="diagram.png"> in a rendered document is the only reason this exists.
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    (workspace / "diagram.png").write_bytes(png)
    status, body = client("/api/raw?path=diagram.png")
    assert status == 200
    assert body == png


def test_raw_refuses_file_types_outside_the_image_set(client) -> None:
    # Otherwise the route quietly becomes a download endpoint for the workspace.
    status, payload = client.json("/api/raw?path=main.py")
    assert status == 400 and "image" in payload["error"]


def test_raw_is_confined_to_the_workspace(client, workspace: Path) -> None:
    (workspace.parent / "outside.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    status, _ = client("/api/raw?path=../outside.png")
    assert status == 400


def test_raw_serves_svg_inert(client, workspace: Path) -> None:
    # An SVG is a document: served with a CSP so opening one cannot run script in
    # the viewer's origin, which is where the rendered page's sanitizing happens.
    (workspace / "d.svg").write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    httpd_status, _ = client("/api/raw?path=d.svg")
    assert httpd_status == 200


def test_an_image_file_gets_the_image_renderer(client, workspace: Path) -> None:
    # Opened from the tree, an image is shown, not reported as binary.
    (workspace / "shot.PNG").write_bytes(b"\x89PNG\r\n\x1a\n\x00" + b"\x00" * 64)
    _, payload = client.json("/api/file?path=shot.PNG")
    assert payload["renderer"] == "image"
    assert payload["body"] == "" and payload["etag"]


def test_an_image_past_the_text_cap_still_renders(client, workspace: Path) -> None:
    (workspace / "big.jpg").write_bytes(b"\xff" * (server.MAX_READ_BYTES + 1))
    _, payload = client.json("/api/file?path=big.jpg")
    assert payload["renderer"] == "image"


def test_an_svg_renders_as_an_image_and_keeps_its_source(client, workspace: Path) -> None:
    svg = "<svg xmlns='http://www.w3.org/2000/svg'/>\n"
    (workspace / "d.svg").write_text(svg)
    _, payload = client.json("/api/file?path=d.svg")
    assert payload["renderer"] == "image"
    assert payload["body"] == svg


def test_a_host_path_into_the_workspace_reads_the_file(cfg, client, workspace: Path) -> None:
    # Agents write ![](/workspace/shot.png); that names the root, not a subdirectory.
    (workspace / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    assert server.resolve(cfg.root, f"{cfg.root}/shot.png") == cfg.root / "shot.png"
    status, _ = client(f"/api/raw?path={cfg.root}/shot.png")
    assert status == 200


def test_a_real_subdirectory_named_like_the_root_wins(cfg, workspace: Path) -> None:
    nested = workspace / str(cfg.root).lstrip("/")
    nested.mkdir(parents=True)
    (nested / "a.png").write_bytes(b"x")
    assert server.resolve(cfg.root, f"{cfg.root}/a.png") == nested / "a.png"


# --- the built frontend -----------------------------------------------------------


def test_assets_are_served_from_the_build_with_a_long_cache(client) -> None:
    # Vite content-hashes the names, so an asset is immutable once served.
    with urllib.request.urlopen(client.url("/static/index-abc123.js")) as resp:
        assert resp.status == 200 and b"app" in resp.read()
        assert "immutable" in resp.headers["cache-control"]


def test_an_asset_cannot_be_escaped(client) -> None:
    status, _ = client("/static/../../etc/passwd")
    assert status in (400, 404)


def test_the_page_links_its_assets_under_the_base(client, cfg) -> None:
    _, body = client("/")
    assert f'src="{cfg.base}/static/index-abc123.js"' in body.decode()


def test_an_unbuilt_frontend_says_so_rather_than_404ing(workspace, tmp_path, client_for) -> None:
    # How `python server.py` runs out of a checkout that never ran `npm run build`.
    unbuilt = server.Config(root=workspace, base="/c/conv-test/files", port=0, static=tmp_path / "none")
    with client_for(unbuilt) as get:
        status, body = get("/")
        assert status == 200 and b"not built" in body
        _, health = get.json("/api/health")
        assert health["frontend"] is False


def test_health_reports_the_frontend_is_built(client) -> None:
    _, payload = client.json("/api/health")
    assert payload["frontend"] is True


# --- config ---------------------------------------------------------------------


def test_config_reads_the_environment_the_unit_sets(workspace: Path) -> None:
    cfg = server.Config.from_env(
        {
            "SCOOTER_FILES_ROOT": str(workspace),
            "SCOOTER_FILES_BASE": "/c/abc/files/",
            "SCOOTER_FILES_PORT": "7801",
            "CONVERSATION_URL": "https://scooter.example.com/?thread=abc",
        }
    )
    assert cfg.root == workspace
    assert cfg.conversation_url == "https://scooter.example.com/?thread=abc"
    assert cfg.base == "/c/abc/files", "a trailing slash would double up in every route"
    assert cfg.port == 7801


def test_config_without_a_base_serves_at_the_root(workspace: Path) -> None:
    # How it runs under `python server.py` on a developer's laptop.
    cfg = server.Config.from_env({"SCOOTER_FILES_ROOT": str(workspace)})
    assert cfg.base == ""
