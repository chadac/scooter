/**
 * Conversation — the object the UI talks to instead of passing a raw id around.
 *
 * A conversation exists in the UI before it exists on the server. The user clicks
 * "+ New conversation" and starts typing; only the first send makes it real, and only the
 * SERVER may assign its id (a client-chosen id would become an event-log key and a k8s
 * resource name). Between those two moments there is no conversation id — and that is the
 * state the old code had no way to express.
 *
 * It papered over the gap with a synthetic UUID, which caused two classes of bug:
 *
 *   1. Every id-keyed call fired against an id the server had never issued. GET
 *      /conversations/<synthetic>/links, /ready, /web-services, /events.integrity — all
 *      404s on a fresh page load.
 *   2. When the real id arrived it REPLACED the synthetic one. Anything keyed on the id
 *      was torn down and rebuilt — including the React runtime, mid-run, which discarded
 *      the in-flight run's state and left the Stop button dead.
 *
 * This class holds the identity instead. `key` is stable for the conversation's whole life
 * (mount on it, select on it, use it as a React key). `id` is the server's, and is
 * undefined until creation. Each method decides for itself what it means when the id is
 * absent, so callers stop branching on presence:
 *
 *   - reads (links, sandbox status, web services, modules) answer EMPTY rather than
 *     fetching a conversation that does not exist;
 *   - actions that require a real conversation (prompt, cancel, resume) create it first
 *     and then act, so "send" always works and never invents an id;
 *   - `id` is exposed only through `serverId()`, which returns undefined rather than a
 *     placeholder, so it is impossible to use one by accident.
 */

export interface ConversationSnapshot {
  /** Stable local identity — never changes, including when the server id arrives. */
  key: string;
  /** The server's conversation id, or undefined before it has been created. */
  id?: string;
  /** True once the server has created this conversation. */
  created: boolean;
}

/** Creates the conversation server-side and returns its id, or null on failure. */
export type CreateConversation = () => Promise<string | null>;

/** Called after the server assigns an id, so the store can record it. */
export type OnCreated = (key: string, id: string) => void;

export class Conversation {
  readonly key: string;
  #id: string | undefined;
  readonly #create: CreateConversation;
  readonly #onCreated: OnCreated | undefined;
  /** One in-flight create, shared by concurrent callers — two sends racing must not make
   *  two conversations. */
  #creating: Promise<string | null> | undefined;

  constructor(opts: {
    key: string;
    id?: string;
    create: CreateConversation;
    onCreated?: OnCreated;
  }) {
    this.key = opts.key;
    this.#id = opts.id;
    this.#create = opts.create;
    this.#onCreated = opts.onCreated;
  }

  /** A conversation the server already knows — its key IS its id. */
  static existing(id: string, create: CreateConversation, onCreated?: OnCreated): Conversation {
    return new Conversation({ key: id, id, create, onCreated });
  }

  /** A conversation the user has started but not yet sent in. It has no server id until
   *  `ensureCreated()` runs, and its key is a local placeholder that never leaves the UI. */
  static pending(key: string, create: CreateConversation, onCreated?: OnCreated): Conversation {
    return new Conversation({ key, create, onCreated });
  }

  /** The server's id, or undefined if this conversation does not exist server-side yet.
   *  The ONLY way to reach the id — deliberately undefined rather than a placeholder, so a
   *  caller cannot accidentally address a conversation that was never created. */
  serverId(): string | undefined {
    return this.#id;
  }

  get created(): boolean {
    return this.#id !== undefined;
  }

  snapshot(): ConversationSnapshot {
    return { key: this.key, id: this.#id, created: this.created };
  }

  /**
   * Ensure the conversation exists server-side, returning its id (or null if creation
   * failed). Idempotent, and concurrent callers share one create.
   *
   * Call this before any action that needs a real conversation. It does NOT change `key`,
   * so nothing keyed on the conversation is torn down when the id appears.
   */
  async ensureCreated(): Promise<string | null> {
    if (this.#id !== undefined) return this.#id;
    if (this.#creating) return this.#creating;
    this.#creating = (async () => {
      const id = await this.#create();
      if (id) {
        this.#id = id;
        this.#onCreated?.(this.key, id);
      }
      return id;
    })().finally(() => {
      this.#creating = undefined;
    });
    return this.#creating;
  }

  /**
   * Run `fn` against the server id, creating the conversation first if needed. For ACTIONS
   * — prompting, cancelling, resuming — where the user's intent implies the conversation
   * should exist. Throws if creation fails: the caller asked to do something, and silently
   * doing nothing would look like a dead control.
   */
  async withId<T>(fn: (id: string) => Promise<T>): Promise<T> {
    const id = await this.ensureCreated();
    if (!id) throw new Error("could not create the conversation — please retry");
    return fn(id);
  }

  /**
   * Run `fn` against the server id only if the conversation already exists; otherwise
   * return `fallback` without touching the network. For READS — links, sandbox status, web
   * services, modules — which have no answer for a conversation that does not exist yet.
   * This is what stops a fresh page load from 404ing on a synthetic id.
   */
  async ifCreated<T>(fn: (id: string) => Promise<T>, fallback: T): Promise<T> {
    const id = this.#id;
    if (id === undefined) return fallback;
    return fn(id);
  }
}
