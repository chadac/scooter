/**
 * A linked resource's text, drawn by the contrib that owns its source (`ui.linkView`), so
 * the contrib decides what a link shows (a PR's "#12", its title) and how it looks. The
 * app only falls back to the plain title: for a source with no view, while the view's
 * chunk loads, and if it is missing from this build or throws.
 */

import { Component, Suspense, type ReactNode } from "react";

import type { LinkViewProps } from "./contrib/sdk.js";
import type { SessionLink } from "./sessions.js";
import { linkName } from "./sessions.js";
import { contribLinkViews } from "./contribManifest.js";
import { lazyContrib } from "./contribTabs.js";

/** Shows the fallback instead of a view that throws; a link row is too small for an error card. */
class Fallback extends Component<{ children: ReactNode; fallback: ReactNode; source: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn(`[ui] the ${this.props.source} link view failed:`, error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function LinkText({ link }: { link: SessionLink }) {
  const plain = <span className="truncate">{linkName(link)}</span>;
  const view = contribLinkViews()[link.source];
  const View = view && lazyContrib<LinkViewProps>(view.entry);
  if (!View) return plain;
  return (
    <span data-testid="contrib-link-view" className="flex min-w-0 flex-1 items-center gap-1.5">
      <Fallback source={link.source} fallback={plain}>
        <Suspense fallback={plain}>
          <View link={link} />
        </Suspense>
      </Fallback>
    </span>
  );
}
