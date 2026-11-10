"""GitHub attachments: find uploads in a body, name them as refs, and download one.

A ref is `gh:<owner>/<repo>:<item>:<url without scheme>`, where `<item>` names the issue,
PR, comment or review the upload appeared in. Uploads on a private repo open only with a
browser session, so the download first re-reads that item as `full+json`: its
`body_html` carries each image as a signed URL valid for about five minutes. Without a
signed URL (a public repo, or a non-image file) the upload's own URL is fetched.
"""

from __future__ import annotations

import html
import re
from collections.abc import Awaitable, Callable
from urllib.parse import unquote, urlsplit

import httpx

from scooter_lib.attachments import AttachmentRef, Fetched, FetchError, dedupe, guarded_get, is_image_name

TOOL = "github_attachment"
FULL_JSON = "application/vnd.github.full+json"

_URL = r"https://[^\s)\"'<>]+"
_MD = re.compile(r"!?\[(?P<text>[^\]\n]*)\]\((?P<url>" + _URL + r")\)")
_IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_ATTR = re.compile(r"\b(?P<key>alt|src)\s*=\s*\"(?P<value>[^\"]*)\"", re.IGNORECASE)
_BARE = re.compile(_URL)
_SIGNED = re.compile(r"(?:src|href)=\"(?P<url>https://[^\"]*jwt=[^\"]*)\"")

_ITEM = r"issue/\d+|comment/\d+|review_comment/\d+|review/\d+/\d+"
_REF = re.compile(r"^gh:(?P<repo>[\w.-]+/[\w.-]+):(?P<item>" + _ITEM + r"):(?P<url>\S+)$")

ApiGet = Callable[[str, dict[str, str]], Awaitable[httpx.Response]]


def _upload_path(host: str, path: str, github_host: str) -> bool:
    """Whether `host` + `path` is an upload rather than any other link."""
    if host == github_host:
        return re.fullmatch(r"/user-attachments/(assets/[\w-]+|files/\d+/[^/]+)", path) is not None
    return host in ("user-images.githubusercontent.com", "private-user-images.githubusercontent.com")


def allowed_host(github_host: str) -> Callable[[str], bool]:
    """The hosts an upload URL may name: the GitHub host and its user-content CDN."""
    return lambda host: host == github_host or host.endswith(".githubusercontent.com")


def parse_refs(text: str, owner: str, repo: str, item: str, github_host: str) -> list[AttachmentRef]:
    """Every upload `text` links to, named by its alt or link text when it has one."""
    text = text or ""
    names: dict[str, str] = {}
    for m in _MD.finditer(text):
        names.setdefault(m["url"], m["text"].strip())
    for tag in _IMG.findall(text):
        attrs = {a["key"].lower(): html.unescape(a["value"]) for a in _ATTR.finditer(tag)}
        if "src" in attrs:
            names.setdefault(attrs["src"], attrs.get("alt", "").strip())
    refs: list[AttachmentRef] = []
    for m in _BARE.finditer(text):
        url = html.unescape(m.group(0)).split("?", 1)[0]
        parts = urlsplit(url)
        if not _upload_path(parts.hostname or "", parts.path, github_host):
            continue
        last = unquote(parts.path.rsplit("/", 1)[-1])
        name = names.get(m.group(0)) or names.get(url) or last
        assets = "/user-attachments/assets/" in parts.path
        refs.append(AttachmentRef(
            name=name,
            ref=f"gh:{owner}/{repo}:{item}:{url.removeprefix('https://')}",
            # Assets may be videos; only sniffed images are shown.
            image=assets or is_image_name(last),
        ))
    return dedupe(refs)


def _item_path(repo: str, item: str) -> str:
    kind, _, rest = item.partition("/")
    base = f"repos/{repo}"
    if kind == "issue":
        return f"{base}/issues/{rest}"
    if kind == "comment":
        return f"{base}/issues/comments/{rest}"
    if kind == "review_comment":
        return f"{base}/pulls/comments/{rest}"
    pr, _, review = rest.partition("/")
    return f"{base}/pulls/{pr}/reviews/{review}"


def _signed_url(body_html: str, url: str) -> str | None:
    """The signed URL `body_html` gives for the upload at `url`, matched by its id."""
    key = urlsplit(url).path.rsplit("/", 1)[-1]
    for m in _SIGNED.finditer(body_html or ""):
        candidate = html.unescape(m["url"])
        if key and key in urlsplit(candidate).path:
            return candidate
    return None


def parse_ref(ref: str, github_host: str) -> tuple[str, str, str]:
    """(`owner/repo`, item, upload URL) for `ref`; FetchError if it isn't an upload ref."""
    m = _REF.match(ref.strip())
    url = f"https://{m['url']}" if m else ""
    parts = urlsplit(url)
    if m is None or ".." in parts.path or not _upload_path(parts.hostname or "", parts.path, github_host):
        raise FetchError(
            f"{ref!r} is not a GitHub attachment ref; pass the `gh:…` ref from the message as written"
        )
    return m["repo"], m["item"], url


async def fetch(
    ref: str, api_get: ApiGet, client: httpx.AsyncClient, *, github_host: str, max_bytes: int,
) -> tuple[str, Fetched]:
    """Download `ref`, through the item's signed URL when GitHub gives one."""
    repo, item, url = parse_ref(ref, github_host)
    name = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
    response = await api_get(_item_path(repo, item), {"Accept": FULL_JSON})
    signed = None
    if response.status_code == 200:
        try:
            signed = _signed_url((response.json() or {}).get("body_html") or "", url)
        except ValueError:
            signed = None
    try:
        # The signed URL is the credential; send no forge header.
        fetched = await guarded_get(client, signed or url, allowed=allowed_host(github_host), max_bytes=max_bytes)
    except FetchError as exc:
        if signed is None and response.status_code != 200:
            raise FetchError(f"{exc}; reading {item} for a signed URL answered HTTP {response.status_code}") from exc
        raise
    return name, fetched
