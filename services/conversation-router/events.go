// The conversation-LIST push stream — GET /conversations/events — served by the router directly
// from Postgres LISTEN/NOTIFY instead of fanning SSE out to every agent-host pod and multiplexing
// their frames. A single dedicated connection LISTENs on 'conversations_changed' (raised by the
// trigger in migration 20260902183131); each notification names one conversation id, whose row the
// loop re-reads and fans out to the subscribers entitled to see it.
//
// Why the store is the source of truth here, not the pods: the fan-out re-emitted whatever each
// pod's in-memory session map said, so a stale per-pod copy could push a `starred`/title value the
// durable row had already superseded. Reading the row the trigger fired on means the push and the
// GET /conversations snapshot (assembleList, same makeListRow) can never disagree.
//
// Contract preserved for the UI (conversationStream.ts): an initial `snapshot` then `upsert`
// frames. Removals are NOT pushed (the trigger fires on delete, but the loop drops it) — exactly as
// agent-host's old emitChange never fired on end(); the 10s poll reconciles removals.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// listenBackoff paces reconnects after the LISTEN connection drops or fails to open. Short: a lost
// notification stream means the sidebar silently stops updating live until the poll, so reconnect
// briskly — but not so tight it hammers a DB that is actually down.
const listenBackoff = 2 * time.Second

// sseHeartbeat keeps the SSE connection (and any intermediary idle timeout) alive between upserts.
// A comment frame the UI parser ignores.
const sseHeartbeat = 25 * time.Second

// subBuffer bounds how many upserts a slow subscriber may queue before the loop drops frames for it
// rather than blocking every OTHER subscriber. A dropped frame is reconciled by the poll; blocking
// the fan-out would let one stuck client freeze live updates for all.
const subBuffer = 64

// sseSub is one connected /conversations/events client: its scope filter and a buffered channel of
// pre-serialized frames. owner/scope decide which upserts it may see (the same boundary the poll
// enforces — the stream must never reveal a conversation the snapshot would hide).
type sseSub struct {
	ch          chan []byte
	callerOwner string
	scope       string
}

// sseHub is the set of live subscribers. broadcast walks it under RLock; subscribe/unsubscribe
// mutate under the write lock.
type sseHub struct {
	mu   sync.RWMutex
	subs map[*sseSub]struct{}
}

func newSSEHub() *sseHub {
	return &sseHub{subs: map[*sseSub]struct{}{}}
}

func (h *sseHub) subscribe(callerOwner, scope string) *sseSub {
	s := &sseSub{ch: make(chan []byte, subBuffer), callerOwner: callerOwner, scope: scope}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *sseHub) unsubscribe(s *sseSub) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// broadcast serializes the upsert ONCE and delivers it to every subscriber the row is visible to.
// The frame bytes are identical across subscribers — only visibility differs — so marshalling per
// subscriber would be waste. A subscriber whose buffer is full is skipped (its poll reconciles),
// never blocked, so one slow client can't stall the fan-out.
func (h *sseHub) broadcast(row listRow) {
	frame, err := json.Marshal(struct {
		Kind         string  `json:"kind"`
		Conversation listRow `json:"conversation"`
	}{Kind: "upsert", Conversation: row})
	if err != nil {
		return
	}
	msg := sseData(frame)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if !visible(row.Owner, s.callerOwner, s.scope) {
			continue
		}
		select {
		case s.ch <- msg:
		default: // buffer full — drop; the 10s poll reconciles this subscriber.
		}
	}
}

// runConversationListener owns the dedicated LISTEN connection: it opens it, LISTENs on the
// channel, and on each notification re-reads the row and fans it out via the hub. It reconnects
// through NewListenConn after any drop (a notification stream is not resumable — reconnect + the
// poll are the recovery), and returns when ctx is cancelled. No-op when store is nil (dev/pg-less).
func runConversationListener(ctx context.Context, store *Store, links *LinkStore, crs crLookup, hub *sseHub) {
	if store == nil {
		return
	}
	log := logger("events-listen")
	for ctx.Err() == nil {
		conn, err := store.NewListenConn(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("listen connect failed; retrying",
				slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
			sleep(ctx, listenBackoff)
			continue
		}
		if _, err := conn.Exec(ctx, "listen conversations_changed"); err != nil {
			if ctx.Err() != nil {
				_ = conn.Close(context.Background())
				return
			}
			log.Warn("LISTEN failed; retrying",
				slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
			_ = conn.Close(context.Background())
			sleep(ctx, listenBackoff)
			continue
		}
		log.Info("listening for conversation changes")
		for ctx.Err() == nil {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("notification wait failed; reconnecting", errAttr(err))
				}
				break
			}
			handleNotification(ctx, n.Payload, store, links, crs, hub, log)
		}
		// Close with a background context: ctx may already be cancelled (shutdown), and a Close on
		// a cancelled context would skip the connection teardown.
		_ = conn.Close(context.Background())
		if ctx.Err() == nil {
			sleep(ctx, listenBackoff)
		}
	}
}

// notifyDecision parses a NOTIFY payload ({id, op}) and applies the drop rules, returning the
// conversation id + CR to read and whether to proceed. Pure (no DB, no logging) so the branch logic
// is unit-testable. Drops:
//   - unparseable / empty-id payloads (never expected from our own trigger);
//   - op=delete — removals ride the 10s poll, exactly as agent-host's emitChange never pushed end();
//   - an id whose CR the cache has not observed — EXISTENCE follows the CR, so pushing a
//     metadata-only row would resurrect a ghost the snapshot omits (the poll catches it up once the
//     watch sees the CR).
func notifyDecision(payload string, crs crLookup) (string, CRInfo, bool) {
	var p struct {
		ID string `json:"id"`
		Op string `json:"op"`
	}
	if err := json.Unmarshal([]byte(payload), &p); err != nil || p.ID == "" || p.Op == "delete" {
		return "", CRInfo{}, false
	}
	cr, ok := crs.CR(p.ID)
	if !ok {
		return "", CRInfo{}, false
	}
	return p.ID, cr, true
}

// handleNotification turns one NOTIFY payload into an upsert broadcast: decide (notifyDecision),
// then re-read the row + links (the payload carries only the id) and fan the built row out.
func handleNotification(ctx context.Context, payload string, store *Store, links *LinkStore, crs crLookup, hub *sseHub, log *slog.Logger) {
	id, cr, proceed := notifyDecision(payload, crs)
	if !proceed {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	m, err := store.ConversationByID(rctx, id)
	if err != nil {
		log.Warn("row re-read failed on notify; dropping upsert", convAttr(id), errAttr(err))
		return
	}
	if m == nil {
		return // raced with a delete between the notify and the read.
	}
	var ls []Link
	if links != nil {
		if got, err := links.LinksForConversation(rctx, id); err != nil {
			log.Warn("link re-read failed on notify; pushing bare row", convAttr(id), errAttr(err))
		} else {
			ls = got
		}
	}
	hub.broadcast(makeListRow(*m, cr, ls, time.Now().UnixMilli()))
}

// serveConversationEvents streams GET /conversations/events from the store: an initial snapshot
// (the caller's visible list, same shape as GET /conversations) then live upserts from the hub.
// The subscription is registered BEFORE the snapshot read so an upsert arriving during that read is
// buffered, not lost — a duplicate upsert of a row already in the snapshot is folded idempotently
// by the UI (mergeFromServer). All writes happen on this one goroutine, so w needs no locking.
func serveConversationEvents(w http.ResponseWriter, r *http.Request, store *Store, links *LinkStore, crs crLookup, hub *sseHub) {
	log := logger("events")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	callerOwner, scope := ownerFrom(r), listScope(r)

	// Subscribe FIRST (see the func comment) — the buffer holds any upsert racing the snapshot.
	sub := hub.subscribe(callerOwner, scope)
	defer hub.unsubscribe(sub)

	if snap := snapshotFrame(r.Context(), store, links, crs, callerOwner, scope, log); snap != nil {
		if _, err := w.Write(snap); err != nil {
			return
		}
		flusher.Flush()
	}

	ticker := time.NewTicker(sseHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-sub.ch:
			if _, err := w.Write(msg); err != nil {
				return // client hung up mid-write.
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// snapshotFrame builds the initial `snapshot` SSE frame — the caller's visible list, assembled the
// same way GET /conversations is. On a store read error it returns an EMPTY-list snapshot rather
// than nil so the client still gets a valid first frame and then rides live upserts + the poll;
// only a marshalling failure (never expected) yields nil.
func snapshotFrame(ctx context.Context, store *Store, links *LinkStore, crs crLookup, callerOwner, scope string, log *slog.Logger) []byte {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var metas []ConversationRow
	if got, err := store.Conversations(rctx); err != nil {
		log.Warn("snapshot read failed; sending empty snapshot", errAttr(err))
	} else {
		metas = got
	}
	linksByConv := map[string][]Link{}
	if links != nil {
		if lm, err := links.LinksByConversation(rctx); err != nil {
			log.Warn("snapshot link read failed; bare rows", errAttr(err))
		} else {
			linksByConv = lm
		}
	}
	rows := assembleList(metas, crs, linksByConv, time.Now().UnixMilli(), callerOwner, scope)
	frame, err := json.Marshal(struct {
		Kind          string    `json:"kind"`
		Conversations []listRow `json:"conversations"`
	}{Kind: "snapshot", Conversations: rows})
	if err != nil {
		log.Warn("snapshot marshal failed", errAttr(err))
		return nil
	}
	return sseData(frame)
}

// sseData wraps a JSON frame in the SSE `data:` envelope the UI parser expects (a frame is
// terminated by the blank line).
func sseData(frame []byte) []byte {
	out := make([]byte, 0, len(frame)+8)
	out = append(out, "data: "...)
	out = append(out, frame...)
	out = append(out, '\n', '\n')
	return out
}
