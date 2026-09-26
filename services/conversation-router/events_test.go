package main

import (
	"encoding/json"
	"testing"
)

// notifyDecision is the pure gate on the LISTEN loop: from a NOTIFY payload alone it decides whether
// to read and push a row. A wrong rule either pushes a removal the snapshot omits, or silently
// swallows a real change.
//
// The "id with no observed CR" rule is GONE with the CR: the row is existence, and an id whose row
// has since been deleted is dropped downstream by handleNotification, where ConversationByID
// returns nil. One store, so there is nothing left to disagree with.
func TestNotifyDecision(t *testing.T) {
	t.Run("a valid upsert proceeds", func(t *testing.T) {
		id, ok := notifyDecision(`{"id":"uuid-live","op":"upsert"}`)
		if !ok || id != "uuid-live" {
			t.Fatalf("want proceed, got (%q,%v)", id, ok)
		}
	})

	t.Run("delete is dropped (removals ride the poll)", func(t *testing.T) {
		if _, ok := notifyDecision(`{"id":"uuid-live","op":"delete"}`); ok {
			t.Error("a delete must not push an upsert")
		}
	})

	t.Run("unparseable / empty-id payloads are dropped", func(t *testing.T) {
		for _, p := range []string{`not json`, `{}`, `{"op":"upsert"}`, ``} {
			if _, ok := notifyDecision(p); ok {
				t.Errorf("payload %q should be dropped", p)
			}
		}
	})
}

// The hub is the fan-out: broadcast must reach exactly the subscribers a row is VISIBLE to (the
// same boundary the poll enforces — the stream must not leak what the list would hide), and must
// never block on a slow subscriber (a full buffer drops, the poll reconciles).
func TestSSEHubBroadcastVisibility(t *testing.T) {
	hub := newSSEHub()
	alice := hub.subscribe("alice", "mine")
	bob := hub.subscribe("bob", "mine")
	all := hub.subscribe("carol", "all")

	// A row owned by alice: alice sees it, bob (mine) does not, the all-scope sub does.
	hub.broadcast(listRow{ID: "x", Owner: sp("alice")})

	if !received(alice) {
		t.Error("owner (alice) must receive her own conversation's upsert")
	}
	if received(bob) {
		t.Error("bob (scope=mine) must NOT receive alice's conversation")
	}
	if !received(all) {
		t.Error("scope=all must receive every conversation")
	}
}

func TestSSEHubUnsubscribeStopsDelivery(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all") // anonymous/all sees everything
	hub.unsubscribe(s)
	hub.broadcast(listRow{ID: "x", Owner: sp("alice")})
	if received(s) {
		t.Error("an unsubscribed client must receive nothing")
	}
}

// A subscriber whose buffer is full must not block the fan-out (one stuck client can't freeze live
// updates for everyone else). broadcast returns; the excess frame is simply dropped.
func TestSSEHubDropsWhenBufferFull(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all")
	// Fill the buffer past capacity — broadcast must never block.
	for i := 0; i < subBuffer+5; i++ {
		hub.broadcast(listRow{ID: "x", Owner: sp("alice")})
	}
	if got := len(s.ch); got != subBuffer {
		t.Fatalf("buffer should cap at %d, got %d", subBuffer, got)
	}
}

// The upsert frame the hub puts on the wire must match the UI contract (conversationStream.ts):
// a `data: {kind:"upsert", conversation:{…}}` line, with the conversation carrying the list-row
// fields verbatim.
func TestSSEHubUpsertFrameShape(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all")
	hub.broadcast(listRow{ID: "c9", Title: "Nine", Status: "running", Owner: sp("alice")})

	msg := <-s.ch
	if got := string(msg[:6]); got != "data: " {
		t.Fatalf("frame must start with the SSE data envelope, got %q", got)
	}
	// Strip "data: " and the trailing blank line.
	body := msg[6 : len(msg)-2]
	var frame struct {
		Kind         string  `json:"kind"`
		Conversation listRow `json:"conversation"`
	}
	if err := json.Unmarshal(body, &frame); err != nil {
		t.Fatalf("frame not valid JSON: %v (%q)", err, string(body))
	}
	if frame.Kind != "upsert" || frame.Conversation.ID != "c9" || frame.Conversation.Title != "Nine" {
		t.Fatalf("unexpected upsert frame: %+v", frame)
	}
}

// received reports whether a subscriber got a frame, without blocking if it did not.
func received(s *sseSub) bool {
	select {
	case <-s.ch:
		return true
	default:
		return false
	}
}
