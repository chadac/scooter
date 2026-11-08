import type { TextMessagePartComponent } from "@assistant-ui/react";
import { Fragment, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";

import { contribSyntax } from "@/src/contribSyntax";
import remarkContribOnly from "@/src/remarkContribOnly";

// Built on first render: contrib syntax loads before first paint.
let syntax: { remarkPlugins: NonNullable<Options["remarkPlugins"]>; components: Components } | undefined;
const userSyntax = () =>
  (syntax ??= {
    remarkPlugins: [...contribSyntax().remarkPlugins, [remarkContribOnly, { tags: Object.keys(contribSyntax().components) }]],
    // The part is already a <p>, so paragraphs add no element.
    components: { ...(contribSyntax().components as Components), p: ({ children }: { children?: ReactNode }) => <Fragment>{children}</Fragment> },
  });

/** Whether user text needs more than the plain default. */
export const hasContribSyntax = (): boolean => contribSyntax().remarkPlugins.length > 0;

/** A user's text as typed, with contrib elements drawn in place. */
export const UserText: TextMessagePartComponent = ({ text }) => (
  <p style={{ whiteSpace: "pre-line" }}>
    <ReactMarkdown {...userSyntax()}>{text}</ReactMarkdown>
  </p>
);
