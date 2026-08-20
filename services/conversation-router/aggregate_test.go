package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Regression for the odin bug: GET /conversations answered by ONE pod returns only the conversations
// that pod hosts. With podCap=1 the fleet spreads them one-per-pod, so the user saw a fraction of
// their conversations — and a different fraction each time the Service picked a different pod.

func TestIsFleetAggregate(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{"GET", "/conversations", true},         // the list — must see the whole fleet
		{"GET", "/conversations/events", true},  // the live list stream — same
		{"GET", "/conversations/abc123", false}, // one conversation — route to its owner
		{"POST", "/conversations", false},       // create — a single pod must own it
		{"GET", "/healthz", false},
		{"GET", "/conversations/abc/events.integrity", false}, // per-conversation stream
	}
	for _, c := range cases {
		if got := IsFleetAggregate(c.method, c.path); got != c.want {
			t.Errorf("IsFleetAggregate(%s %s) = %v, want %v", c.method, c.path, got, c.want)
		}
	}
}

// /conversations/events must NOT parse as a conversation whose id is "events" — that made the live
// sidebar stream route to one arbitrary pod (the same single-pod-view bug as the list).
func TestEventsIsNotAConversationID(t *testing.T) {
	if id, ok := ConvIDFromPath("/conversations/events"); ok {
		t.Errorf("/conversations/events parsed as conversation id %q — it is the fleet list stream", id)
	}
	if id, ok := ConvIDFromPath("/conversations/real-id-123"); !ok || id != "real-id-123" {
		t.Errorf("a real id must still parse: got (%q,%v)", id, ok)
	}
}

/** A fake agent-host pod serving only the conversations IT hosts — exactly the real behaviour. */
func fakePod(t *testing.T, rows []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
	}))
}

func conv(id string, activity float64) map[string]any {
	return map[string]any{"id": id, "title": "c-" + id, "lastActivityAt": activity}
}

func urlOf(t *testing.T, s *httptest.Server) *url.URL {
	t.Helper()
	u, err := url.Parse(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestAggregatedListMergesEveryPod(t *testing.T) {
	// Three pods, disjoint slices — the shape observed on odin.
	a := fakePod(t, []map[string]any{conv("a1", 300), conv("a2", 100)})
	b := fakePod(t, []map[string]any{conv("b1", 200)})
	c := fakePod(t, []map[string]any{conv("c1", 400)})
	defer a.Close()
	defer b.Close()
	defer c.Close()

	req := httptest.NewRequest("GET", "/conversations", nil)
	rec := httptest.NewRecorder()
	serveAggregatedList(rec, req, []*url.URL{urlOf(t, a), urlOf(t, b), urlOf(t, c)})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got []map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("merged list = %d conversations, want 4 (the union of all pods)", len(got))
	}
	// Newest first, so the UI ordering is unchanged from the single-pod case.
	if got[0]["id"] != "c1" || got[3]["id"] != "a2" {
		t.Errorf("not ordered newest-first: %v", []any{got[0]["id"], got[1]["id"], got[2]["id"], got[3]["id"]})
	}
}

func TestAggregatedListDeDupesAcrossPods(t *testing.T) {
	// During a reassignment hand-off the SAME conversation can briefly appear on two pods.
	a := fakePod(t, []map[string]any{conv("dup", 100), conv("only-a", 50)})
	b := fakePod(t, []map[string]any{conv("dup", 100)})
	defer a.Close()
	defer b.Close()

	rec := httptest.NewRecorder()
	serveAggregatedList(rec, httptest.NewRequest("GET", "/conversations", nil),
		[]*url.URL{urlOf(t, a), urlOf(t, b)})

	var got []map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if len(got) != 2 {
		t.Fatalf("de-dupe failed: got %d rows, want 2", len(got))
	}
}

func TestAggregatedListDegradesOnPartialFailure(t *testing.T) {
	// One pod down must NOT blank the sidebar — a partial list beats a 502.
	ok := fakePod(t, []map[string]any{conv("alive", 10)})
	defer ok.Close()
	dead, _ := url.Parse("http://127.0.0.1:1") // nothing listening

	rec := httptest.NewRecorder()
	serveAggregatedList(rec, httptest.NewRequest("GET", "/conversations", nil),
		[]*url.URL{urlOf(t, ok), dead})

	if rec.Code != http.StatusOK {
		t.Fatalf("a single dead pod must not fail the request: status %d", rec.Code)
	}
	var got []map[string]any
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if len(got) != 1 || got[0]["id"] != "alive" {
		t.Errorf("expected the reachable pod's conversations, got %v", got)
	}
}

func TestAggregatedListFailsWhenEveryPodFails(t *testing.T) {
	// If NOTHING answers, that is an outage — returning [] would render as "you have no
	// conversations", which is the very illusion this bug created.
	d1, _ := url.Parse("http://127.0.0.1:1")
	d2, _ := url.Parse("http://127.0.0.1:2")
	rec := httptest.NewRecorder()
	serveAggregatedList(rec, httptest.NewRequest("GET", "/conversations", nil), []*url.URL{d1, d2})
	if rec.Code != http.StatusBadGateway {
		t.Errorf("all-upstreams-down should be 502, got %d", rec.Code)
	}
}

func TestAggregatedListForwardsIdentityHeaders(t *testing.T) {
	// Each pod applies its own per-user visibility filter, so the caller's identity MUST reach it —
	// otherwise the fan-out could leak another user's conversations.
	seen := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("X-Auth-User")
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	}))
	defer srv.Close()

	req := httptest.NewRequest("GET", "/conversations", nil)
	req.Header.Set("X-Auth-User", "alice")
	serveAggregatedList(httptest.NewRecorder(), req, []*url.URL{urlOf(t, srv)})

	if got := <-seen; got != "alice" {
		t.Errorf("identity not forwarded to the pod: got %q", got)
	}
}

func TestAggregatedSSEMultiplexesEveryPod(t *testing.T) {
	// The live list stream must carry frames from EVERY pod, not one.
	mk := func(id string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"from\":\"%s\"}\n\n", id)
			w.(http.Flusher).Flush()
		}))
	}
	a, b := mk("pod-a"), mk("pod-b")
	defer a.Close()
	defer b.Close()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/conversations/events", nil)
	serveAggregatedSSE(rec, req, []*url.URL{urlOf(t, a), urlOf(t, b)})

	body := rec.Body.String()
	for _, want := range []string{"pod-a", "pod-b"} {
		if !strings.Contains(body, want) {
			t.Errorf("SSE aggregate missing frames from %s; body=%q", want, body)
		}
	}
}

func TestHostsDeDupesAndSorts(t *testing.T) {
	c := NewOwnershipCache()
	c.set("c1", "10.0.0.2")
	c.set("c2", "10.0.0.1")
	c.set("c3", "10.0.0.2") // two conversations on one pod -> ONE host
	c.set("c4", "")         // unassigned -> skipped
	got := c.Hosts()
	if len(got) != 2 || got[0] != "10.0.0.1" || got[1] != "10.0.0.2" {
		t.Errorf("Hosts() = %v, want [10.0.0.1 10.0.0.2]", got)
	}
}
