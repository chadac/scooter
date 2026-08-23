"""Generate the kubenix option reference: one page PER NAMESPACE + a filterable index.

Input: options.json from `nix build .#options-doc` (nixosOptionsDoc's optionsJSON), whose path
comes from SCOOTER_OPTIONS_JSON. Writes docs/reference/options/*.md (all gitignored) BEFORE
mkdocs runs — `just docs` and the Docs workflow both do this, so the reference cannot drift
from the modules and nothing generated is ever committed.

WHY SPLIT. The first cut published one 4,400-line CommonMark page. mkdocs indexes that as a
SINGLE search document, so searching "byoc" scored the whole page rather than the option: you
got "Configuration options" and then had to ctrl-F. One page per top-level namespace
(agentSandbox.byoc, .agent, .broker, …) gives each namespace its own search document, its own
deep links, and a table of contents.
"""

from __future__ import annotations

import json
import os
import pathlib
from collections import defaultdict

OPTIONS_JSON = os.environ.get("SCOOTER_OPTIONS_JSON", "")
OUT_DIR = os.environ.get("SCOOTER_OPTIONS_OUT", "docs/reference/options")

# Namespaces with fewer options than this are folded into the "misc" page rather than each
# getting a nearly-empty page of their own (a page per one-option namespace is worse to
# navigate than a short shared list).
MIN_PAGE_OPTIONS = 3

PREFIX = "agentSandbox."


def namespace_of(name: str) -> str:
    """The top-level namespace: agentSandbox.byoc.ingress.host -> byoc. Options directly under
    agentSandbox (e.g. agentSandbox.namespace) group as "core"."""
    rest = name[len(PREFIX):] if name.startswith(PREFIX) else name
    parts = rest.split(".")
    return parts[0] if len(parts) > 1 else "core"


def fence(value: str, lang: str = "nix") -> str:
    """A fenced block that survives values containing backticks."""
    ticks = "```"
    while ticks in value:
        ticks += "`"
    return f"{ticks}{lang}\n{value.rstrip()}\n{ticks}"


def render_option(name: str, opt: dict) -> str:
    out = [f"### `{name}`", ""]
    desc = (opt.get("description") or "").strip()
    if desc:
        out += [desc, ""]
    out += [f"**Type:** {opt.get('type', '—')}", ""]
    for label, key in (("Default", "default"), ("Example", "example")):
        val = opt.get(key)
        if isinstance(val, dict) and "text" in val:
            out += [f"**{label}:**", "", fence(str(val["text"])), ""]
        elif val is not None:
            out += [f"**{label}:**", "", fence(json.dumps(val, indent=2), "json"), ""]
    decls = opt.get("declarations") or []
    links = [
        f"[{d['name']}]({d['url']})" if isinstance(d, dict) and d.get("url")
        else f"`{d.get('name', d) if isinstance(d, dict) else d}`"
        for d in decls
    ]
    if links:
        out += [f"*Declared in:* {', '.join(links)}", ""]
    return "\n".join(out)


def write(rel: str, text: str) -> None:
    path = pathlib.Path(OUT_DIR) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def main() -> None:
    if not OPTIONS_JSON or not os.path.exists(OPTIONS_JSON):
        # No generated input (a docs-only local edit): leave a page that says so rather than
        # failing the build with a confusing mkdocs nav error.
        write(
            "index.md",
            "# Configuration options\n\n"
            "!!! warning \"Not generated in this build\"\n"
            "    Run `just docs` (or the Docs workflow) to render the option reference "
            "from the kubenix modules.\n",
        )
        return

    with open(OPTIONS_JSON) as f:
        options = json.load(f)

    groups: dict[str, dict] = defaultdict(dict)
    for name, opt in sorted(options.items()):
        groups[namespace_of(name)][name] = opt

    # Fold tiny namespaces together so navigation stays meaningful.
    misc: dict[str, dict] = {}
    for ns in list(groups):
        if ns != "core" and len(groups[ns]) < MIN_PAGE_OPTIONS:
            misc.update(groups.pop(ns))
    if misc:
        groups["misc"].update(misc)

    for ns, opts in sorted(groups.items()):
        title = "Core" if ns == "core" else ("Other options" if ns == "misc" else f"`agentSandbox.{ns}`")
        lines = [
            f"# {title}",
            "",
            f"{len(opts)} option{'s' if len(opts) != 1 else ''}, generated from the kubenix "
            "modules — this page cannot drift from the code.",
            "",
        ]
        lines += [render_option(name, opt) for name, opt in sorted(opts.items())]
        write(f"{ns}.md", "\n".join(lines))

    # The index: a client-side filter over EVERY option (fast scanning + deep links into the
    # per-namespace pages above).
    index = [
        "# Configuration options",
        "",
        f"Every `agentSandbox.*` option ({len(options)} total), generated from the kubenix "
        "modules via `nixosOptionsDoc` — this reference cannot drift from the code.",
        "",
        "Type to filter; click an option to jump to its full entry.",
        "",
        '<input class="opt-filter" type="search" placeholder="Filter options — try: byoc, model, ingress"'
        ' aria-label="Filter options" autocomplete="off">',
        '<div class="opt-count"></div>',
        '<div class="opt-list">',
    ]
    for ns, opts in sorted(groups.items()):
        for name, opt in sorted(opts.items()):
            anchor = name.lower().replace(".", "").replace("_", "")
            summary = " ".join((opt.get("description") or "").split())
            if len(summary) > 160:
                summary = summary[:157].rstrip() + "…"
            index.append(
                f'<div class="opt-row" data-opt="{name.lower()} {summary.lower()}">'
                f'<a href="{ns}/#{anchor}"><code>{name}</code></a>'
                f'<span class="opt-type">{opt.get("type", "")}</span>'
                f'<p>{summary}</p></div>'
            )
    index += ["</div>", ""]
    write("index.md", "\n".join(index))

    # awesome-pages reads .pages for this directory's nav title + ordering: index first, then
    # the namespace pages alphabetically. mkdocs' own nav cannot glob, and hand-listing
    # generated pages in mkdocs.yml would rot the moment a namespace appears.
    write(".pages", "title: Configuration options\nnav:\n  - index.md\n  - ...\n")


main()
