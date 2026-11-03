/**
 * Hosts for contrib Session-tab sections (`ui.panel`) and fenced-block renderers
 * (`ui.markdownFences`). Both load lazily from the same module table as settings
 * tabs, and both are contained: a missing entry, a chunk that fails to load, or a
 * render that throws shows an error in that tab or block only.
 */

import { Component, Suspense, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";

import type { MarkdownFenceProps, PanelProps } from "./contrib/sdk.js";
import type { ContribMarkdownFence, ContribPanel } from "./contribTypes.js";
import { lazyContrib } from "./contribTabs.js";

class Boundary extends Component<{ children: ReactNode; what: string; testId: string }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[ui] ${this.props.what} failed:`, error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const e = this.state.error;
    return <Failed what={this.props.what} testId={this.props.testId} error={e instanceof Error ? e : String(e)} />;
  }
}

function Failed({ what, testId, error }: { what: string; testId: string; error: string | Error }) {
  return <ErrorState variant="boxed" data-testid={testId} title={`${what} failed to load.`} error={error} />;
}

const outOfStep = (entry: string) =>
  `${entry} is not in this UI build; the UI image and the contrib manifest are out of step.`;

/** One contrib's Session-tab section body. */
export function ContribPanelBody({ panel, setCount }: { panel: ContribPanel } & PanelProps) {
  const Panel = lazyContrib<PanelProps>(panel.entry);
  const what = `The ${panel.label} section`;
  if (!Panel) return <Failed what={what} testId="contrib-panel-error" error={outOfStep(panel.entry)} />;
  return (
    <Boundary what={what} testId="contrib-panel-error">
      <Suspense
        fallback={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading {panel.label}…
          </div>
        }
      >
        <Panel setCount={setCount} />
      </Suspense>
    </Boundary>
  );
}

/** One fenced block drawn by the contrib that claimed its language. */
export function ContribFence({ fence, lang, body }: { fence: ContribMarkdownFence; lang: string } & MarkdownFenceProps) {
  const Fence = lazyContrib<MarkdownFenceProps>(fence.entry);
  const what = `The ${lang} block`;
  if (!Fence) return <Failed what={what} testId="contrib-fence-error" error={outOfStep(fence.entry)} />;
  return (
    <Boundary what={what} testId="contrib-fence-error">
      <Suspense fallback={<Spinner />}>
        <Fence body={body} />
      </Suspense>
    </Boundary>
  );
}

// assistant-ui reads a fence's language with /language-(\w+)/, which stops at a hyphen,
// so each claimed language is rewritten to a hyphen-free token before parsing. A
// language has no "_", so mapping "-" to "_" keeps distinct languages distinct.
const fenceToken = (lang: string) => `contribfence_${lang.replace(/-/g, "_")}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite each opening fence of a claimed language to its token. */
export function preprocessFences(text: string, langs: readonly string[]): string {
  if (langs.length === 0) return text;
  const re = new RegExp(`^([ \\t]{0,3}(?:\`{3,}|~{3,}))[ \\t]*(${langs.map(escapeRe).join("|")})[ \\t]*$`, "gm");
  return text.replace(re, (_m, open: string, lang: string) => `${open}${fenceToken(lang)}`);
}

type FenceComponents = Record<string, { SyntaxHighlighter: (p: { code: string }) => ReactNode; CodeHeader: () => null }>;

/** assistant-ui's `componentsByLanguage` for the claimed languages: the body, no code header. */
export function fenceComponents(fences: Record<string, ContribMarkdownFence>): FenceComponents {
  return Object.fromEntries(
    Object.entries(fences).map(([lang, fence]) => [
      fenceToken(lang),
      {
        SyntaxHighlighter: ({ code }: { code: string }) => <ContribFence fence={fence} lang={lang} body={code} />,
        CodeHeader: () => null,
      },
    ]),
  );
}
