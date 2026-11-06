// Per-conversation topics, carried on GET /conversations/:id/events.integrity.

/** One frame on the state stream; a topic without `data` means "refetch". */
export type StateFrame =
  | { kind: "topic"; topic: string; data?: unknown }
  | { kind: "synced" };

export type StateListener = (frame: StateFrame) => void;

/** A topic source that runs only while its conversation is watched. */
export type StateProducer = (conversationId: string, publish: (topic: string, data: unknown) => void) => {
  stop(): void;
  /** Re-read now rather than on the next tick. */
  nudge?(): void;
};

export interface StateHub {
  /** Fan out to subscribers; data frames are kept for late joiners. */
  publish(conversationId: string, topic: string, data?: unknown): void;
  /** Kept values, then `synced`, then live frames; returns the unsubscribe. */
  subscribe(conversationId: string, listener: StateListener): () => void;
  nudge(conversationId: string): void;
  subscribers(conversationId: string): number;
}

interface Watched {
  listeners: Set<StateListener>;
  values: Map<string, unknown>;
  producers: ReturnType<StateProducer>[];
}

export function createStateHub(producers: readonly StateProducer[] = []): StateHub {
  const watched = new Map<string, Watched>();

  const deliver = (w: Watched, frame: StateFrame) => {
    for (const l of [...w.listeners]) {
      try {
        l(frame);
      } catch {
        // One dead socket must not starve the others.
      }
    }
  };

  const publish = (conversationId: string, topic: string, data?: unknown) => {
    const w = watched.get(conversationId);
    // Unwatched: the next subscriber reads current state itself.
    if (!w) return;
    if (data === undefined) w.values.delete(topic);
    else w.values.set(topic, data);
    deliver(w, data === undefined ? { kind: "topic", topic } : { kind: "topic", topic, data });
  };

  return {
    publish,
    subscribe(conversationId, listener) {
      let w = watched.get(conversationId);
      const first = !w;
      if (!w) {
        w = { listeners: new Set(), values: new Map(), producers: [] };
        watched.set(conversationId, w);
      }
      for (const [topic, data] of w.values) listener({ kind: "topic", topic, data });
      w.listeners.add(listener);
      listener({ kind: "synced" });
      if (first) {
        w.producers = producers.map((p) => p(conversationId, (topic, data) => publish(conversationId, topic, data)));
      }
      return () => {
        const cur = watched.get(conversationId);
        if (!cur || !cur.listeners.delete(listener) || cur.listeners.size > 0) return;
        watched.delete(conversationId);
        for (const p of cur.producers) p.stop();
      };
    },
    nudge(conversationId) {
      for (const p of watched.get(conversationId)?.producers ?? []) p.nudge?.();
    },
    subscribers(conversationId) {
      return watched.get(conversationId)?.listeners.size ?? 0;
    },
  };
}

/** The `sandbox` topic's value. */
interface SandboxTopic {
  status: string;
  ready: boolean;
  services: unknown[];
}

export interface SandboxWatcherDeps {
  /** Read every tick, so keep it in memory; "unknown" if absent. */
  status(conversationId: string): Promise<string>;
  /** Asked only while status is "running". */
  ready(conversationId: string): Promise<boolean>;
  /** Asked only while running and ready. */
  services(conversationId: string): Promise<unknown[]>;
  /** Tick period until the pod is running and ready. */
  startingMs?: number;
  runningMs?: number;
}

/** The built-in `sandbox` topic: one probe loop per watched conversation. */
export function sandboxWatcher(deps: SandboxWatcherDeps): StateProducer {
  const startingMs = deps.startingMs ?? 2_000;
  const runningMs = deps.runningMs ?? 5_000;

  return (conversationId, publish) => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: SandboxTopic | undefined;
    let inFlight: Promise<void> | undefined;
    let again = false;

    const read = async (): Promise<SandboxTopic> => {
      const status = await deps.status(conversationId).catch(() => "unknown");
      if (status !== "running") return { status, ready: false, services: [] };
      const ready = await deps.ready(conversationId).catch(() => false);
      const services = ready ? await deps.services(conversationId).catch(() => last?.services ?? []) : [];
      return { status, ready, services };
    };

    const periodFor = (v: SandboxTopic) => (v.ready ? runningMs : startingMs);

    const tick = (): Promise<void> => {
      // A nudge mid-read re-reads after, so the action's result lands.
      if (inFlight) {
        again = true;
        return inFlight;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      inFlight = (async () => {
        const v = await read();
        if (stopped) return;
        if (JSON.stringify(last) !== JSON.stringify(v)) {
          last = v;
          publish("sandbox", v);
        }
        timer = setTimeout(() => void tick(), periodFor(v));
      })().finally(() => {
        inFlight = undefined;
        if (again && !stopped) {
          again = false;
          void tick();
        }
      });
      return inFlight;
    };

    void tick();
    return {
      stop() {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      },
      nudge() {
        if (!stopped) void tick();
      },
    };
  };
}
