"""The shared half of a search contrib's `web_search` (scooter_broker_lib/search.py).

These live here rather than in brave's or kagi's suite because the point of the module
is that every search contrib behaves IDENTICALLY from the agent's side: swapping the
provider changes the bill and the ranking, never the output format or how the outcomes
are told apart. A rule tested in one contrib's suite would be free to drift in the
other's.

Why: issue #700, porting PR #698.
"""

from __future__ import annotations

import httpx

from scooter_broker_lib.search import (
    MAX_RESULTS,
    SearchHit,
    hits_from,
    search_response,
    search_result,
)


# --- the three outcomes, kept distinct --------------------------------------------
#
# The implementation this replaces answered a real query with HTTP 200 and "no instant
# answer", so an agent could not tell an empty web from the wrong API. An agent told
# "no results" retries the query; one told "HTTP 401" reports a broken key.

def test_a_failure_carries_the_status_and_body_VERBATIM():
    _body, failure = search_response(httpx.Response(429, text="quota exhausted"), provider="brave")
    assert failure is not None and failure.is_error
    assert "429" in failure.text
    assert "quota exhausted" in failure.text
    assert "brave" in failure.text


def test_a_success_is_decoded_and_not_a_failure():
    body, failure = search_response(httpx.Response(200, json={"web": {}}), provider="brave")
    assert failure is None
    assert body == {"web": {}}


def test_a_204_is_not_a_failure():
    """Any 2xx means the call worked; the body decides whether it found anything."""
    body, failure = search_response(httpx.Response(204), provider="kagi")
    assert (body, failure) == ({}, None)


def test_a_200_THAT_IS_NOT_JSON_is_a_FAILURE_not_an_empty_web():
    """Something answered that was not the search API — a proxy error page, a captive
    portal. Reporting that as "no results" is the exact bug this replaced: an agent
    told "no results" retries the query forever."""
    _body, failure = search_response(
        httpx.Response(200, text="<html>Gateway</html>"), provider="brave"
    )
    assert failure is not None and failure.is_error
    assert "not JSON" in failure.text
    assert "Gateway" in failure.text


def test_a_200_whose_json_is_not_an_object_is_no_results():
    """The call worked and we understood nothing in it, which is what an API change
    looks like — distinct from nothing having answered at all."""
    body, failure = search_response(httpx.Response(200, json=[1, 2, 3]), provider="kagi")
    assert failure is None and body == {}


def test_no_hits_is_SUCCESS_and_names_the_provider():
    out = search_result([], query="nothing matches this", provider="kagi")
    assert not out.is_error
    assert out.text == 'No results for "nothing matches this" (via kagi).'


# --- rendering --------------------------------------------------------------------

def test_hits_render_one_per_line_with_the_snippet_indented():
    hits = [
        SearchHit(title="First", url="https://a.test", snippet="about first"),
        SearchHit(title="Second", url="https://b.test"),
    ]
    out = search_result(hits, query="q", provider="brave")
    assert out.text == (
        'Results for "q":\n'
        "- First (https://a.test)\n"
        "  about first\n"
        "- Second (https://b.test)"
    )


def test_the_rendered_list_is_capped_even_if_a_provider_ignores_the_count():
    hits = [SearchHit(title=f"r{i}", url=f"https://x.test/{i}") for i in range(MAX_RESULTS + 7)]
    out = search_result(hits, query="q", provider="brave")
    assert len([l for l in out.text.splitlines() if l.startswith("- ")]) == MAX_RESULTS


# --- unpacking a provider's rows --------------------------------------------------

def test_each_provider_names_its_own_fields():
    """The providers agree on the shape of a result and disagree only on the field
    names, which is the whole reason this helper is parameterized by them."""
    brave_rows = [{"title": "T", "url": "https://x.test", "description": "D"}]
    kagi_rows = [{"title": "T", "url": "https://x.test", "snippet": "D"}]
    assert hits_from(brave_rows, title="title", url="url", snippet="description") == hits_from(
        kagi_rows, title="title", url="url", snippet="snippet"
    )


def test_a_row_with_no_url_is_DROPPED():
    """A hit the agent cannot follow is not a result. Kagi's related-searches row is
    the real case: it carries a `list` and no url."""
    rows = [{"title": "unfollowable"}, {"title": "ok", "url": "https://x.test"}]
    assert hits_from(rows, title="title", url="url", snippet="snippet") == [
        SearchHit(title="ok", url="https://x.test", snippet=None)
    ]


def test_a_whitespace_url_counts_as_no_url():
    assert hits_from([{"url": "   "}], title="title", url="url", snippet="s") == []


def test_a_titleless_row_falls_back_to_its_url():
    """Better than rendering `- (https://…)`, which reads as a bug."""
    assert hits_from([{"url": "https://x.test"}], title="title", url="url", snippet="s") == [
        SearchHit(title="https://x.test", url="https://x.test", snippet=None)
    ]


def test_unpacking_stops_at_the_cap():
    rows = [{"url": f"https://x.test/{i}"} for i in range(MAX_RESULTS + 5)]
    assert len(hits_from(rows, title="title", url="url", snippet="s")) == MAX_RESULTS
