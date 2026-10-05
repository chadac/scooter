"""Reading hits off DuckDuckGo's HTML page (scooter_contrib_duckduckgo/html_results.py).

Fixtures are trimmed copies of the real page's shape. The assertions worth having are
the ones about what the agent is handed — a followable url, no ads — and the three-way
classification of a page with no hits, which is where the bug this stack removed lived:
the old tool reported a non-answer as an empty web, so an agent concluded the web had
nothing rather than that search was broken.
"""

from __future__ import annotations

from scooter_broker_lib.search import MAX_RESULTS

from scooter_contrib_duckduckgo.html_results import classify, hits_from_html, target_url


def _result(href: str, title: str, snippet: str | None = None) -> str:
    snippet_html = (
        f'<a class="result__snippet" href="{href}">{snippet}</a>' if snippet else ""
    )
    return (
        '<div class="result results_links results_links_deep web-result">'
        '<div class="links_main"><h2 class="result__title">'
        f'<a rel="nofollow" class="result__a" href="{href}">{title}</a></h2>'
        f"{snippet_html}</div></div>"
    )


def _page(*results: str) -> str:
    return f"<html><body><div id='links' class='results'>{''.join(results)}</div></body></html>"


REDIRECT = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fkagi.com%2Fapi&amp;rut=abc123"


def test_a_redirect_wrapped_hit_is_unwrapped_to_its_real_url():
    """The href DDG writes points at DDG. Handing that to the agent would send
    `web_fetch` through a tracking redirect instead of to the page it asked for."""
    hits = hits_from_html(_page(_result(REDIRECT, "Kagi API", "The API docs.")))
    assert [(h.title, h.url, h.snippet) for h in hits] == [
        ("Kagi API", "https://kagi.com/api", "The API docs.")
    ]


def test_a_direct_href_is_taken_as_written():
    hits = hits_from_html(_page(_result("https://example.com/page", "Example")))
    assert [h.url for h in hits] == ["https://example.com/page"]


def test_a_sponsored_link_is_dropped():
    """Ads carry `result__a` like any other hit, so the /y.js path is what tells them
    apart. The agent asked the web a question, not a marketplace."""
    page = _page(
        _result("//duckduckgo.com/y.js?ad_provider=bing&u3=https%3A%2F%2Fad.test", "Buy"),
        _result("https://real.test/", "Real"),
    )
    assert [h.url for h in hits_from_html(page)] == ["https://real.test/"]


def test_markup_inside_a_title_becomes_plain_text():
    """DDG bolds the query terms. `<b>` tags in a title would read as markup to the
    model and waste tokens either way."""
    hits = hits_from_html(_page(_result("https://x.test/", "the <b>kagi</b> api")))
    assert hits[0].title == "the kagi api"


def test_entities_are_decoded():
    hits = hits_from_html(_page(_result("https://x.test/", "Tom &amp; Jerry&#x27;s")))
    assert hits[0].title == "Tom & Jerry's"


def test_a_hit_with_no_followable_url_is_dropped():
    """A relative or javascript: href is not something the agent can fetch."""
    page = _page(_result("javascript:void(0)", "Nope"), _result("https://ok.test/", "Yes"))
    assert [h.url for h in hits_from_html(page)] == ["https://ok.test/"]


def test_the_result_list_is_capped_like_every_other_provider():
    page = _page(*[_result(f"https://x.test/{i}", f"r{i}") for i in range(MAX_RESULTS + 5)])
    assert len(hits_from_html(page)) == MAX_RESULTS


def test_a_result_with_no_snippet_keeps_the_others_snippets():
    """The parser attaches a snippet to the open row, so a result without one must not
    inherit the next result's."""
    page = _page(
        _result("https://a.test/", "A"),
        _result("https://b.test/", "B", "B's summary"),
    )
    hits = hits_from_html(page)
    assert [(h.title, h.snippet) for h in hits] == [("A", None), ("B", "B's summary")]


def test_target_url_rejects_a_redirect_wrapping_something_unfetchable():
    assert target_url("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)") == ""


# --- the three-way classification of a page with no hits ---------------------------

def test_ddgs_own_no_results_notice_is_an_EMPTY_search():
    assert classify('<div class="no-results">No results.</div>') == "empty"


def test_the_bot_check_page_is_BLOCKED():
    assert classify("<script src='/dist/anomaly.js'></script>") == "blocked"
    assert classify("<p>Unfortunately, bots use DuckDuckGo too.</p>") == "blocked"


def test_anything_else_is_UNRECOGNIZED_and_therefore_a_failure():
    """The default must be failure, not emptiness: a page we cannot read is evidence
    about this scraper, not about the web. This is the inverse of the bug in PR #698."""
    assert classify("<html><body><h1>Welcome to your WiFi portal</h1></body></html>") == "unrecognized"


def test_blocked_OUTRANKS_no_results():
    """The two mistakes are not symmetric. Calling a block "empty" tells the agent the
    web had nothing — the #698 failure exactly — while calling an empty result set a
    failure only makes it report a problem it could have ignored."""
    assert classify('<div class="no-results">No results.</div><script src="anomaly.js">') == "blocked"
