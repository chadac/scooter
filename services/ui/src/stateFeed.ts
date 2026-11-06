// Conversation state topics, fed by each conversation's integrity stream.

/** A topic without `data` means "changed, refetch". */
export type StateFrame = { kind: "topic"; topic: string; data?: unknown };

export type TopicEvent =
  | { kind: "data"; data: unknown }
  | { kind: "invalidate" }
  | { kind: "open" }
  | { kind: "down" };

type Reader = (e: TopicEvent) => void;

interface Channel {
  readers: Map<string, Set<Reader>>;
  /** Last pushed value per topic, for readers mounting later. */
  values: Map<string, unknown>;
  /** Integrity connections currently synced for this conversation. */
  links: number;
}

export function createStateFeed() {
  const channels = new Map<string, Channel>();

  const channel = (id: string): Channel => {
    let ch = channels.get(id);
    if (!ch) channels.set(id, (ch = { readers: new Map(), values: new Map(), links: 0 }));
    return ch;
  };
  const prune = (id: string, ch: Channel) => {
    if (ch.links === 0 && ch.readers.size === 0 && channels.get(id) === ch) channels.delete(id);
  };
  const each = (ch: Channel, fn: (r: Reader) => void, topic?: string) => {
    const sets = topic === undefined ? [...ch.readers.values()] : [ch.readers.get(topic) ?? new Set<Reader>()];
    for (const set of sets) for (const r of [...set]) fn(r);
  };

  return {
    /** A stream for `id` reached `synced`; topics follow on it. */
    open(id: string): void {
      const ch = channel(id);
      if (ch.links++ === 0) each(ch, (r) => r({ kind: "open" }));
    },
    /** A synced stream for `id` ended. */
    down(id: string): void {
      const ch = channels.get(id);
      if (!ch || ch.links === 0) return;
      if (--ch.links === 0) each(ch, (r) => r({ kind: "down" }));
      prune(id, ch);
    },
    frame(id: string, f: StateFrame): void {
      const ch = channels.get(id);
      if (!ch) return;
      if (f.data === undefined) {
        ch.values.delete(f.topic);
        each(ch, (r) => r({ kind: "invalidate" }), f.topic);
      } else {
        ch.values.set(f.topic, f.data);
        each(ch, (r) => r({ kind: "data", data: f.data }), f.topic);
      }
    },
    /** The reader hears the kept value first; returns the unsubscribe. */
    subscribe(id: string, topic: string, reader: Reader): () => void {
      const ch = channel(id);
      let set = ch.readers.get(topic);
      if (!set) ch.readers.set(topic, (set = new Set()));
      set.add(reader);
      if (ch.values.has(topic)) reader({ kind: "data", data: ch.values.get(topic) });
      if (ch.links > 0) reader({ kind: "open" });
      return () => {
        const s = ch.readers.get(topic);
        s?.delete(reader);
        if (s && s.size === 0) ch.readers.delete(topic);
        prune(id, ch);
      };
    },
    size: () => channels.size,
  };
}

export type StateFeed = ReturnType<typeof createStateFeed>;

/** The page's feed; integrityAgent writes it, conversationState reads it. */
export const stateFeed = createStateFeed();
