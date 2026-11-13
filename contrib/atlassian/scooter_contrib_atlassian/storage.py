"""Confluence storage format (XHTML) to and from Markdown, and exact-match edits over either."""

from __future__ import annotations

import html
import re

from bs4 import BeautifulSoup, Tag
from markdown_it import MarkdownIt
from markdownify import MarkdownConverter

# Storage needs closed void tags; raw HTML is escaped.
_md = MarkdownIt("commonmark", {"xhtmlOut": True, "html": False}).enable(["table", "strikethrough"])

_FENCE = re.compile(r'<pre><code(?: class="language-([^"]*)")?>(.*?)</code></pre>', re.S)


def _code_macro(m: re.Match) -> str:
    lang, code = m.group(1), html.unescape(m.group(2))
    param = f'<ac:parameter ac:name="language">{lang}</ac:parameter>' if lang else ""
    # "]]>" would end the CDATA early, so split it.
    body = code.rstrip("\n").replace("]]>", "]]]]><![CDATA[>")
    return f'<ac:structured-macro ac:name="code">{param}<ac:plain-text-body><![CDATA[{body}]]></ac:plain-text-body></ac:structured-macro>'


def markdown_to_storage(text: str) -> str:
    """Markdown as storage XHTML, with fenced code as Confluence's code macro."""
    return _FENCE.sub(_code_macro, _md.render(text)).strip()


def _soup(storage: str) -> BeautifulSoup:
    return BeautifulSoup(storage, "html.parser")


def _is_code_macro(tag: Tag) -> bool:
    return tag.name == "ac:structured-macro" and tag.get("ac:name") == "code"


def lossy_elements(storage: str) -> list[str]:
    """The Confluence-only elements (macros, layouts, mentions, images) Markdown would drop, by name, deduplicated."""
    found: list[str] = []
    for tag in _soup(storage).find_all(True):
        if ":" not in tag.name or any(_is_code_macro(p) for p in [tag, *tag.parents] if isinstance(p, Tag)):
            continue
        name = f"{tag.name} {tag.get('ac:name')}" if tag.get("ac:name") else tag.name
        if name not in found:
            found.append(name)
    return found


class _Converter(MarkdownConverter):
    def convert_pre(self, el, text, parent_tags):
        lang = el.get("data-language", "")
        return f"\n\n```{lang}\n{el.get_text()}\n```\n\n"


def storage_to_markdown(storage: str) -> str:
    """Storage XHTML as Markdown; code macros become fences and other Confluence elements keep only their text."""
    soup = _soup(storage)
    for macro in soup.find_all("ac:structured-macro"):
        if not _is_code_macro(macro):
            continue
        pre = soup.new_tag("pre")
        lang = macro.find("ac:parameter", attrs={"ac:name": "language"})
        if lang:
            pre["data-language"] = lang.get_text(strip=True)
        body = macro.find("ac:plain-text-body")
        pre.string = "".join(s for s in body.contents if isinstance(s, str)) if body else ""
        macro.replace_with(pre)
    md = _Converter(heading_style="ATX", bullets="-", escape_underscores=False).convert_soup(soup)
    return re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"


class EditError(Exception):
    """An edit whose `old` text did not match exactly once; nothing was applied."""

    def __init__(self, index: int, matches: int) -> None:
        found = "no match" if matches == 0 else f"{matches} matches"
        super().__init__(f"edit {index}: `old` must match exactly once in the current page, found {found}. "
                         "Nothing was written. Re-read the page and make `old` longer and exact.")
        self.index, self.matches = index, matches


def apply_edits(text: str, edits: list[tuple[str, str]]) -> str:
    """Each (old, new) applied in order, each old matching exactly once; raises EditError on the first that doesn't."""
    for i, (old, new) in enumerate(edits):
        n = text.count(old) if old else 0
        if n != 1:
            raise EditError(i, n)
        text = text.replace(old, new, 1)
    return text


