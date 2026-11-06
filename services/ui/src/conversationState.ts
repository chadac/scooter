// Topic readers over the conversation state carried on events.integrity.

import { useEffect, useRef, useState } from "react";

import { currentConversation, useSessions } from "./sessions.js";
import { stateFeed, type StateFeed } from "./stateFeed.js";
import { pollWhileVisible } from "./visiblePoll.js";

export interface TopicOptions<T> {
  /** Runs on connect and on every invalidation. */
  load?: () => Promise<T>;
  /** Poll `load` this often while the stream is down. */
  fallbackPollMs?: number;
}

/** Follow one topic; `opts` is read per use, so loaders may change. */
export function watchTopic<T>(
  feed: StateFeed,
  conversationId: string,
  topic: string,
  opts: () => TopicOptions<T>,
  onValue: (value: T) => void,
  poll: typeof pollWhileVisible = pollWhileVisible,
): () => void {
  let alive = true;
  // A newer value outranks any load still in flight.
  let seq = 0;
  const load = () => {
    const fn = opts().load;
    if (!fn) return;
    const mine = ++seq;
    void fn().then(
      (value) => {
        if (alive && mine === seq) onValue(value);
      },
      () => {
        /* keep the last value; the next invalidation or reconnect retries */
      },
    );
  };
  let stopPoll: (() => void) | undefined;
  const stopFallback = () => {
    stopPoll?.();
    stopPoll = undefined;
  };
  const startFallback = () => {
    const { fallbackPollMs, load: fn } = opts();
    if (!fallbackPollMs || !fn || stopPoll) return;
    stopPoll = poll(load, fallbackPollMs);
  };

  let connected = false;
  const unsub = feed.subscribe(conversationId, topic, (e) => {
    if (!alive) return;
    if (e.kind === "data") {
      seq++;
      onValue(e.data as T);
    } else if (e.kind === "invalidate") {
      load();
    } else if (e.kind === "open") {
      connected = true;
      stopFallback();
      load();
    } else {
      connected = false;
      startFallback();
    }
  });
  // Not yet connected: read now, and poll if it never connects.
  if (!connected) {
    load();
    startFallback();
  }
  return () => {
    alive = false;
    stopFallback();
    unsub();
  };
}

/** A state-stream topic of the open conversation. */
export function useConversationTopic<T>(
  topic: string,
  opts: TopicOptions<T> = {},
  feed: StateFeed = stateFeed,
): T | undefined {
  useSessions(); // re-render when the server id arrives
  const id = currentConversation()?.serverId();
  const [value, setValue] = useState<T | undefined>(undefined);
  // Fresh closures each render must not re-subscribe.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    setValue(undefined);
    if (!id) return;
    return watchTopic<T>(feed, id, topic, () => optsRef.current, (v) => setValue(() => v));
  }, [id, topic, feed]);

  return value;
}
