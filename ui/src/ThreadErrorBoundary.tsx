/**
 * Error boundary around the assistant-ui Thread.
 *
 * The runtime can throw a TRANSIENT internal error (observed:
 * "useClientLookup: Index N out of bounds") when our render pump's
 * runtime.thread.reset() shrinks/reorders the message list while assistant-ui is
 * mid-render holding a stale index — e.g. during a model-switch bridge rebuild,
 * when the integrity stream reconnects and re-folds. Without a boundary, that
 * throw blanks the WHOLE page (the observed model-switch flake: a blank screen).
 *
 * This catches it and recovers: it resets its error state whenever `resetKey`
 * changes (the render pump bumps it on every message change), so the next
 * consistent render re-mounts the Thread. A transient runtime hiccup becomes a
 * one-frame blip instead of a dead page.
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bumped by the parent on every message change; a change clears the error so
   *  the Thread re-mounts against the now-consistent runtime state. */
  resetKey: unknown;
}

interface State {
  error: unknown;
}

export class ThreadErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A new render cycle (resetKey changed) — clear the error and try again.
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: unknown) {
    // Observable, not silent — a PERSISTENT crash should still be diagnosable.
    console.warn("[ui] Thread render error (recovering on next update):", error);
  }

  render() {
    // While errored, render nothing (not the broken subtree) — the boundary
    // re-mounts children when resetKey advances.
    return this.state.error !== null ? null : this.props.children;
  }
}
