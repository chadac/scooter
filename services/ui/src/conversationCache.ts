/**
 * Browser cache of conversation folds, so reopening a conversation paints at once and its
 * stream resumes from the cached cursor instead of replaying the log. It lives in
 * IndexedDB (localStorage holds ~5 MB and blocks the main thread), is scoped to the
 * signed-in user, and is bounded by a byte budget evicted least-recently-opened first.
 * Every operation is best-effort: a failing store degrades to a cache miss.
 */

export const CACHE_BUDGET_BYTES = 50 * 1024 * 1024;
/** Eviction trims to here, leaving headroom for later writes. */
export const CACHE_LOW_WATER_BYTES = 45 * 1024 * 1024;
export const CACHE_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Bump on a stored-shape change; a mismatch wipes the cache. */
export const CACHE_SCHEMA_VERSION = 1;
/** How long a read waits for /whoami before missing. */
const USER_WAIT_MS = 2000;

/** The small record eviction scans, stored apart from the fold. */
export interface CacheEntry {
  id: string;
  bytes: number;
  openedAt: number;
  savedAt: number;
}

export interface CacheMeta {
  version: number;
  userId: string;
}

/** Storage under the cache; folds are stored as JSON strings. */
export interface CacheBackend {
  getMeta(): Promise<CacheMeta | undefined>;
  putMeta(meta: CacheMeta): Promise<void>;
  getFold(id: string): Promise<string | undefined>;
  /** Writes the fold and its entry together. */
  putFold(entry: CacheEntry, json: string): Promise<void>;
  touch(id: string, openedAt: number): Promise<void>;
  entries(): Promise<CacheEntry[]>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ConversationCache {
  /** Scope to `userId`, wiping another user's cache. */
  setUser(userId: string): Promise<void>;
  /** The cached fold, or undefined; marks it just opened. */
  load<T>(id: string): Promise<T | undefined>;
  save(id: string, fold: unknown): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Limits and clock, overridable for tests. */
export interface CacheOptions {
  budget?: number;
  lowWater?: number;
  maxEntry?: number;
  maxAge?: number;
  now?: () => number;
}

export function createConversationCache(backend: CacheBackend, opts: CacheOptions = {}): ConversationCache {
  const {
    budget = CACHE_BUDGET_BYTES,
    lowWater = CACHE_LOW_WATER_BYTES,
    maxEntry = CACHE_MAX_ENTRY_BYTES,
    maxAge = CACHE_MAX_AGE_MS,
    now = Date.now,
  } = opts;
  let userKnown = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  // One wait per page, so a slow /whoami costs once.
  let userWait: Promise<boolean> | undefined;
  // One write at a time, so eviction never races a save.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const next = chain.then(fn).catch((e) => {
      console.warn("[conversationCache] dropped an operation:", e);
      return undefined;
    });
    chain = next;
    return next;
  };

  const evict = async () => {
    const entries = await backend.entries();
    const cutoff = now() - maxAge;
    const expired = entries.filter((e) => e.savedAt < cutoff);
    let live = entries.filter((e) => e.savedAt >= cutoff);
    let total = live.reduce((n, e) => n + e.bytes, 0);
    const drop = expired.map((e) => e.id);
    if (total > budget) {
      live = [...live].sort((a, b) => a.openedAt - b.openedAt);
      for (const e of live) {
        if (total <= lowWater) break;
        drop.push(e.id);
        total -= e.bytes;
      }
    }
    if (drop.length) await backend.remove(drop);
  };

  return {
    async setUser(userId) {
      await serial(async () => {
        const meta = await backend.getMeta();
        if (!meta || meta.userId !== userId || meta.version !== CACHE_SCHEMA_VERSION) {
          await backend.clear();
          await backend.putMeta({ version: CACHE_SCHEMA_VERSION, userId });
        }
      });
      userKnown = true;
      markReady();
    },

    async load<T>(id: string) {
      userWait ??= Promise.race([ready.then(() => true), delay(USER_WAIT_MS).then(() => false)]);
      if (!userKnown && !(await userWait)) return undefined;
      return serial(async () => {
        const json = await backend.getFold(id);
        if (json === undefined) return undefined;
        await backend.touch(id, now());
        return JSON.parse(json) as T;
      });
    },

    async save(id, fold) {
      // Never write before the cache is scoped to a user.
      if (!userKnown) return;
      await serial(async () => {
        const json = JSON.stringify(fold);
        if (json.length > maxEntry) {
          await backend.remove([id]);
          return;
        }
        const at = now();
        await backend.putFold({ id, bytes: json.length, openedAt: at, savedAt: at }, json);
        await evict();
      });
    },

    async remove(id) {
      await serial(() => backend.remove([id]));
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An in-memory backend, for tests and browsers without IndexedDB. */
export function memoryBackend(): CacheBackend & { folds: Map<string, string> } {
  let meta: CacheMeta | undefined;
  const folds = new Map<string, string>();
  const entries = new Map<string, CacheEntry>();
  return {
    folds,
    getMeta: async () => meta,
    putMeta: async (m) => void (meta = m),
    getFold: async (id) => folds.get(id),
    putFold: async (e, json) => {
      folds.set(e.id, json);
      entries.set(e.id, e);
    },
    touch: async (id, openedAt) => {
      const e = entries.get(id);
      if (e) entries.set(id, { ...e, openedAt });
    },
    entries: async () => [...entries.values()],
    remove: async (ids) => {
      for (const id of ids) {
        folds.delete(id);
        entries.delete(id);
      }
    },
    clear: async () => {
      folds.clear();
      entries.clear();
    },
  };
}

const DB_NAME = "scooter-conversation-cache";
const META = "meta";
const FOLDS = "folds";
const ENTRIES = "entries";

/** IndexedDB backend with meta, folds and entries stores. */
export function indexedDbBackend(idb: IDBFactory): CacheBackend {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore(META);
        d.createObjectStore(FOLDS);
        d.createObjectStore(ENTRIES, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async <T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (t: IDBTransaction) => IDBRequest<T> | void,
  ): Promise<T | undefined> => {
    const t = (await db()).transaction(stores, mode);
    const req = body(t);
    return new Promise<T | undefined>((resolve, reject) => {
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    getMeta: () => tx<CacheMeta>([META], "readonly", (t) => t.objectStore(META).get(META)),
    putMeta: async (m) => void (await tx([META], "readwrite", (t) => void t.objectStore(META).put(m, META))),
    getFold: (id) => tx<string>([FOLDS], "readonly", (t) => t.objectStore(FOLDS).get(id)),
    putFold: async (e, json) =>
      void (await tx([FOLDS, ENTRIES], "readwrite", (t) => {
        t.objectStore(FOLDS).put(json, e.id);
        t.objectStore(ENTRIES).put(e);
      })),
    touch: async (id, openedAt) =>
      void (await tx([ENTRIES], "readwrite", (t) => {
        const store = t.objectStore(ENTRIES);
        const get = store.get(id);
        get.onsuccess = () => {
          if (get.result) store.put({ ...(get.result as CacheEntry), openedAt });
        };
      })),
    entries: async () => (await tx<CacheEntry[]>([ENTRIES], "readonly", (t) => t.objectStore(ENTRIES).getAll())) ?? [],
    remove: async (ids) =>
      void (await tx([FOLDS, ENTRIES], "readwrite", (t) => {
        for (const id of ids) {
          t.objectStore(FOLDS).delete(id);
          t.objectStore(ENTRIES).delete(id);
        }
      })),
    clear: async () =>
      void (await tx([META, FOLDS, ENTRIES], "readwrite", (t) => {
        t.objectStore(META).clear();
        t.objectStore(FOLDS).clear();
        t.objectStore(ENTRIES).clear();
      })),
  };
}

/** The app's cache, on IndexedDB where the browser has it. */
export const conversationCache = createConversationCache(
  typeof indexedDB === "undefined" ? memoryBackend() : indexedDbBackend(indexedDB),
);
