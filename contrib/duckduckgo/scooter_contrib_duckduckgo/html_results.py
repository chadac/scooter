"""Read search hits off DuckDuckGo's HTML results page (`html.duckduckgo.com/html/`).

A page meant for browsers, so there is no contract: expect it to change shape, and
expect to be rate-limited per source address. Both arrive as a 200 carrying no results,
which is why `classify` makes an unreadable page a failure rather than an empty web.

Parsed with stdlib `html.parser`: lxml or bs4 would be weight in the broker image for a
page we read two tags out of. Why: PR #707.
"""

from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import parse_qs, urlparse

from scooter_broker_lib.search import MAX_RESULTS, SearchHit

# The result anchor and its snippet on the HTML endpoint.
RESULT_CLASS = "result__a"
SNIPPET_CLASS = "result__snippet"

# Ads carry `result__a` like any other hit, so the href is what tells them apart: a
# class check would need the markup AROUND the anchor, the part most likely to change.
AD_PATH = "/y.js"

# "DDG answered with a bot check", lowercased. Keep NARROW: these outrank the
# no-results markers (see `classify`), so a loose phrase here — "please try again" also
# appears on the genuine no-results page — turns "nothing found" into a failure.
BLOCKED_MARKERS = (
    "anomaly",
    "bots use duckduckgo",
    "challenge-form",
)
# "DDG said the web had nothing" — the only case where no hits is the truth rather
# than a symptom.
NO_RESULTS_MARKERS = (
    "no results.",
    "no results found",
    "no-results",
    'class="no-results"',
)


class _ResultParser(HTMLParser):
    """Collect (title, href, snippet) triples in document order.

    Flat state machine, not a tree walk: the wrapper divs are restyled, while these two
    anchor classes are the stable part of the page.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, str]] = []
        self._capturing: str | None = None
        self._href = ""
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if tag == "a" and RESULT_CLASS in classes:
            self._emit()
            self._capturing = "title"
            self._href = attributes.get("href") or ""
        elif SNIPPET_CLASS in classes:
            self._emit()
            self._capturing = "snippet"

    def handle_endtag(self, tag: str) -> None:
        # Titles close with their anchor; a snippet may be an <a>, a <div> or a <td>
        # depending on which variant of the page answered.
        if self._capturing == "title" and tag == "a":
            self._emit()
        elif self._capturing == "snippet" and tag in ("a", "div", "td", "span"):
            self._emit()

    def handle_data(self, data: str) -> None:
        if self._capturing is not None:
            self._chunks.append(data)

    def close(self) -> None:  # noqa: D102 - flush a page that ends mid-capture
        super().close()
        self._emit()

    def _emit(self) -> None:
        if self._capturing is None:
            return
        text = " ".join("".join(self._chunks).split())
        if self._capturing == "title":
            self.rows.append({"title": text, "href": self._href, "snippet": ""})
        elif self.rows and not self.rows[-1]["snippet"]:
            # Snippets follow their title, so the open row is the one this belongs to.
            self.rows[-1]["snippet"] = text
        self._capturing = None
        self._chunks = []
        self._href = ""


def target_url(href: str) -> str:
    """The real destination behind a result link, or "" if there is none.

    DDG wraps most hits in `//duckduckgo.com/l/?uddg=<encoded>`, so the href as written
    is a DDG url — handing that to the agent sends `web_fetch` through a tracking
    redirect instead of to the page, and the agent cannot tell the difference.
    """
    link = (href or "").strip()
    if not link:
        return ""
    if link.startswith("//"):
        link = f"https:{link}"
    parsed = urlparse(link)
    if "uddg" in parse_qs(parsed.query):
        inner = parse_qs(parsed.query)["uddg"][0].strip()
        return inner if urlparse(inner).scheme in ("http", "https") else ""
    if parsed.scheme not in ("http", "https"):
        return ""
    return link


def is_ad(url: str) -> bool:
    """A sponsored link. Dropped: the agent asked the web a question, not a marketplace."""
    return urlparse(url).path.startswith(AD_PATH)


def hits_from_html(page: str) -> list[SearchHit]:
    """Every result on the page, in DDG's own order, capped like any other provider."""
    parser = _ResultParser()
    parser.feed(page)
    parser.close()

    hits: list[SearchHit] = []
    for row in parser.rows:
        url = target_url(row["href"])
        if not url or is_ad(url):
            continue
        hits.append(
            SearchHit(title=row["title"] or url, url=url, snippet=row["snippet"] or None)
        )
        if len(hits) >= MAX_RESULTS:
            break
    return hits


def classify(page: str) -> str:
    """Why a page yielded no hits: "blocked", "empty" (DDG said so), or "unrecognized".

    Only "empty" is a successful search; a page we cannot read is evidence about this
    scraper, not about the web, so "unrecognized" must stay a failure.

    BLOCKED IS CHECKED FIRST and the order matters: calling a block "empty" tells the
    agent the web is empty, while calling an empty result set a failure only makes it
    report a problem it could have ignored. Why: PR #707.
    """
    lowered = page.lower()
    if any(marker in lowered for marker in BLOCKED_MARKERS):
        return "blocked"
    if any(marker in lowered for marker in NO_RESULTS_MARKERS):
        return "empty"
    return "unrecognized"
