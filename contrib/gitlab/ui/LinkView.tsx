/**
 * How a GitLab link reads in the Linked panel and the sidebar, in GitLab's own reference
 * style: "!12 <title>" for a merge request, "#12 <title>" for an issue or work item, the
 * reference muted and never truncated. A title that already shows it is left as it is.
 */

import type { LinkViewProps } from "@/src/contrib/sdk";

/** GitLab's short reference for an MR, issue or work item URL ("!12", "#12"), or undefined. */
export function gitlabReference(url: string | undefined): string | undefined {
  const m = url?.match(/\/-\/(merge_requests|issues|work_items)\/(\d+)(?:[/?#]|$)/);
  if (!m) return undefined;
  return `${m[1] === "merge_requests" ? "!" : "#"}${m[2]}`;
}

export default function GitLabLinkView({ link }: LinkViewProps) {
  const ref = gitlabReference(link.url);
  const title = link.title ?? (link.resourceType === "issue" ? "GitLab issue" : "GitLab merge request");
  const show = ref !== undefined && !new RegExp(`${ref}(?!\\d)`).test(title);
  return (
    <>
      {show && <span className="shrink-0 font-mono text-xs text-muted-foreground">{ref}</span>}
      <span className="truncate">{title}</span>
    </>
  );
}
