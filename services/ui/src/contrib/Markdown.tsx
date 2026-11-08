import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import remarkDropHtmlComments from "../remarkDropHtmlComments.js";
import { markdownUrlTransform } from "../markdownImagePolicy.js";
import { contribSyntax } from "../contribSyntax.js";

// Styles each element from the wrapper, like the chat's markdown.
const PROSE = cn(
  "text-sm leading-relaxed break-words",
  "[&_p]:my-2 [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold",
  "[&_ul]:my-2 [&_ul]:ms-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:ms-5 [&_ol]:list-decimal [&_li]:mt-1",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-2 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
);

const baseComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  // A link: a remote image would load without consent.
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || src}
      </a>
    ) : null,
};

// Built on first render: contrib syntax loads before first paint.
let syntax: { remarkPlugins: NonNullable<Options["remarkPlugins"]>; components: Components } | undefined;
const withContribSyntax = () =>
  (syntax ??= {
    remarkPlugins: [remarkGfm, remarkDropHtmlComments, ...contribSyntax().remarkPlugins],
    components: { ...baseComponents, ...(contribSyntax().components as Components) },
  });

/** Markdown the user or the agent wrote, rendered as the chat renders it, without raw HTML. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown
        remarkPlugins={withContribSyntax().remarkPlugins}
        urlTransform={markdownUrlTransform}
        components={withContribSyntax().components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
