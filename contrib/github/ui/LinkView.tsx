/**
 * How a GitHub link reads in the Linked panel and the sidebar: "#12 <title>" for a PR or
 * issue, the number muted and never truncated. A title that already shows the number
 * (the webhooks' "owner/repo #12") is left as it is; an untitled link reads "#12 owner/repo".
 */

import type { LinkViewProps } from "@/src/contrib/sdk";

/** The PR or issue number in a github.com URL, or undefined. */
export function githubNumber(url: string | undefined): string | undefined {
  return url?.match(/\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/)?.[1];
}

/** The "owner/repo" of a PR or issue URL, or undefined. */
export function githubRepo(url: string | undefined): string | undefined {
  return url?.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/)?.[1];
}

export default function GitHubLinkView({ link }: LinkViewProps) {
  const n = githubNumber(link.url);
  const title =
    link.title ?? githubRepo(link.url) ?? (link.resourceType === "issue" ? "GitHub issue" : "GitHub pull request");
  const show = n !== undefined && !new RegExp(`#${n}(?!\\d)`).test(title);
  return (
    <>
      {show && <span className="shrink-0 font-mono text-xs text-muted-foreground">#{n}</span>}
      <span className="truncate">{title}</span>
    </>
  );
}
