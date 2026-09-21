/**
 * One place that turns a linked resource's IDENTITY — a URL, or a webhooks
 * `resource_id` — into the structured target the reply tools need (owner/repo/number,
 * project/iid, issue key).
 *
 * WHY THIS EXISTS: the same resource is written in two shapes by two writers. The
 * webhooks service stores `chadac/scooter#487` in `conversation_map`; every link that
 * arrives through the agent-host API (the broker's auto-link injector, an explicit
 * `link add`) stores the `html_url` in `resource_links` and carries NO `ref`. A
 * resolver that understood only one shape found nothing for the other, so
 * `github_comment` was silently never registered for URL-form links — the agent had no
 * way to reply on the PR it was working on. Why: PR #570 / issue #563.
 *
 * Parsers are deliberately host-agnostic (the link's `source` already says which
 * provider it is) and return undefined rather than guess — a wrong target posts a
 * comment on someone else's PR, which is worse than no tool at all.
 */

import type { ConversationLink } from "../session/manager.js";

export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface GitlabTarget {
  /** The project PATH — GitLab accepts it URL-encoded in place of the numeric id. */
  projectId: string;
  iid: string;
  isMr: boolean;
}

export interface JiraTarget {
  issueKey: string;
}

/** Path segments of a URL, or undefined when it isn't a parseable http(s) URL. */
function segments(url: string | undefined): string[] | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.pathname.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
}

/** `https://github.com/<owner>/<repo>/(pull|issues)/<number>` (+ any suffix, e.g.
 *  `/files` or `#issuecomment-…`). Enterprise hosts differ, so the HOST is not checked. */
export function parseGithubUrl(url: string | undefined): GithubTarget | undefined {
  const segs = segments(url);
  if (!segs || segs.length < 4) return undefined;
  const [owner, repo, kind, num] = segs;
  if (!["pull", "pulls", "issues", "issue"].includes(kind)) return undefined;
  if (!/^\d+$/.test(num)) return undefined;
  return { owner, repo, number: Number(num) };
}

/** `https://gitlab.com/<group>/…/<project>/-/(merge_requests|issues)/<iid>`. The `/-/`
 *  separator is optional (older URLs omit it) and the project path may nest subgroups,
 *  so the kind segment — not a fixed position — is what splits project from iid. */
export function parseGitlabUrl(url: string | undefined): GitlabTarget | undefined {
  const segs = segments(url);
  if (!segs) return undefined;
  const at = segs.findIndex((s) => s === "merge_requests" || s === "issues");
  if (at < 1) return undefined;
  const iid = segs[at + 1];
  if (!iid || !/^\d+$/.test(iid)) return undefined;
  const path = segs.slice(0, at).filter((s) => s !== "-");
  if (path.length < 2) return undefined; // need at least namespace/project
  return { projectId: path.join("/"), iid, isMr: segs[at] === "merge_requests" };
}

/** `https://<site>/browse/<KEY-123>`. */
export function parseJiraUrl(url: string | undefined): JiraTarget | undefined {
  const segs = segments(url);
  if (!segs) return undefined;
  const at = segs.indexOf("browse");
  const key = at >= 0 ? segs[at + 1] : undefined;
  if (!key || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) return undefined;
  return { issueKey: key.toUpperCase() };
}

/**
 * The structured `ref` a link SHOULD carry, derived from its URL — for links written
 * without one (the broker auto-link injector posts url+title only). Returns undefined
 * when nothing is derivable, so the caller stores null rather than an empty object.
 *
 * A GitLab issue's number goes in `iid`, never `mrIid`: a reader that saw `mrIid` would
 * comment on the merge request of that number instead.
 */
export function refFromUrl(source: string, url: string | undefined): ConversationLink["ref"] | undefined {
  if (!url) return undefined;
  switch (source) {
    case "github": {
      const t = parseGithubUrl(url);
      return t ? { owner: t.owner, repo: t.repo, number: t.number } : undefined;
    }
    case "gitlab": {
      const t = parseGitlabUrl(url);
      if (!t) return undefined;
      return t.isMr ? { projectId: t.projectId, mrIid: t.iid } : { projectId: t.projectId, iid: t.iid };
    }
    case "jira": {
      const t = parseJiraUrl(url);
      return t ? { issueKey: t.issueKey } : undefined;
    }
    default:
      return undefined;
  }
}

/** The link with a derived `ref` filled in when it has none. An explicit ref always
 *  wins — the webhooks handlers know more than a URL does. */
export function withDerivedRef(link: ConversationLink): ConversationLink {
  if (link.ref && Object.keys(link.ref).length > 0) return link;
  const ref = refFromUrl(link.source, link.url);
  return ref ? { ...link, ref } : link;
}
