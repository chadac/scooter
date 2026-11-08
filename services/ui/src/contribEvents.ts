// Contribs' change pushes for the signed-in user, from /conversations/events.

/** An empty list means any of the contrib's data may have changed. */
type Listener = (conversations: string[]) => void;

export function createContribEvents() {
  const listeners = new Map<string, Set<Listener>>();
  const call = (set: Set<Listener> | undefined, conversations: string[]) => {
    for (const l of [...(set ?? [])]) l(conversations);
  };
  return {
    emit(contrib: string, conversations: string[]): void {
      call(listeners.get(contrib), conversations);
    },
    /** A reconnected stream may have missed pushes, so tell every contrib. */
    emitAll(): void {
      for (const set of listeners.values()) call(set, []);
    },
    /** Returns the unsubscribe. */
    on(contrib: string, l: Listener): () => void {
      let set = listeners.get(contrib);
      if (!set) listeners.set(contrib, (set = new Set()));
      set.add(l);
      return () => {
        set.delete(l);
        if (set.size === 0 && listeners.get(contrib) === set) listeners.delete(contrib);
      };
    },
  };
}

export const contribEvents = createContribEvents();
