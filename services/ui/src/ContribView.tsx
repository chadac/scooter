/**
 * Hosts a contrib's alternate view (`ui.views`) below the header. The module takes no
 * props and reads the route, conversations and folders from the SDK. A missing entry, a
 * chunk that fails to load or a render that throws shows an error in the view only.
 */

import { Component, Suspense, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";

import type { ContribView as ViewRow } from "./contribTypes.js";
import { lazyContrib } from "./contribTabs.js";

class Boundary extends Component<{ children: ReactNode; label: string }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[ui] the ${this.props.label} view failed:`, error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const e = this.state.error;
    return <Failed label={this.props.label} error={e instanceof Error ? e : String(e)} />;
  }
}

function Failed({ label, error }: { label: string; error: string | Error }) {
  return <ErrorState variant="boxed" data-testid="contrib-view-error" title={`The ${label} view failed to load.`} error={error} />;
}

export function ContribViewHost({ id, view }: { id: string; view: ViewRow }) {
  const View = lazyContrib(view.entry);
  if (!View) {
    return <Failed label={view.label} error={`${view.entry} is not in this UI build; the UI image and the contrib manifest are out of step.`} />;
  }
  return (
    <div data-testid="contrib-view" data-view={id} className="h-full min-h-0">
      <Boundary key={id} label={view.label}>
        <Suspense
          fallback={
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> Loading {view.label}…
            </div>
          }
        >
          <View />
        </Suspense>
      </Boundary>
    </div>
  );
}
