package main

import "testing"

func TestConvIDFromPath(t *testing.T) {
	cases := []struct {
		path   string
		want   string
		wantOK bool
	}{
		{"/conversations/abc123", "abc123", true},
		{"/conversations/abc123/events.integrity", "abc123", true},
		{"/conversations/abc123/cancel", "abc123", true},
		{"/conversations/abc123/links", "abc123", true},
		{"/c/xyz789/marimo/", "xyz789", true},           // web-service proxy (HTTP or WS)
		{"/c/xyz789/ttyd/socket", "xyz789", true},
		{"/conversations", "", false},                    // no id
		{"/healthz", "", false},                          // non-scoped
		{"/agui", "", false},                             // id is in the body, not path
		{"/", "", false},
	}
	for _, c := range cases {
		got, ok := ConvIDFromPath(c.path)
		if got != c.want || ok != c.wantOK {
			t.Errorf("ConvIDFromPath(%q) = (%q,%v), want (%q,%v)", c.path, got, ok, c.want, c.wantOK)
		}
	}
}

func TestIsConversationListRoute(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{"GET", "/conversations", true},         // the list — served from the store, not a pod
		{"GET", "/conversations/events", true},  // the live list stream — same
		{"GET", "/conversations/abc123", false}, // one conversation — route to its owner
		{"POST", "/conversations", false},       // create — a single pod must own it
		{"GET", "/healthz", false},
		{"GET", "/conversations/abc/events.integrity", false}, // per-conversation stream
	}
	for _, c := range cases {
		if got := IsConversationListRoute(c.method, c.path); got != c.want {
			t.Errorf("IsConversationListRoute(%s %s) = %v, want %v", c.method, c.path, got, c.want)
		}
	}
}

// /conversations/events must NOT parse as a conversation whose id is "events" — that would route
// the live sidebar stream to one arbitrary pod instead of the store-backed list stream.
func TestEventsIsNotAConversationID(t *testing.T) {
	if id, ok := ConvIDFromPath("/conversations/events"); ok {
		t.Errorf("/conversations/events parsed as conversation id %q — it is the list events stream", id)
	}
	if id, ok := ConvIDFromPath("/conversations/real-id-123"); !ok || id != "real-id-123" {
		t.Errorf("a real id must still parse: got (%q,%v)", id, ok)
	}
}

func TestIsAguiPost(t *testing.T) {
	if !IsAguiPost("POST", "/agui") {
		t.Error("POST /agui should be an agui post")
	}
	if IsAguiPost("GET", "/agui") {
		t.Error("GET /agui is not an agui post")
	}
	if IsAguiPost("POST", "/conversations/x") {
		t.Error("POST /conversations/x is not an agui post")
	}
}

func TestIsNonScoped(t *testing.T) {
	for _, p := range []string{"/healthz", "/health", "/metrics", "/"} {
		if !IsNonScoped(p) {
			t.Errorf("%q should be non-scoped", p)
		}
	}
	for _, p := range []string{"/conversations/x", "/c/x/marimo/", "/agui"} {
		if IsNonScoped(p) {
			t.Errorf("%q should be conversation-scoped", p)
		}
	}
}

func TestTargetURL(t *testing.T) {
	// Route by POD IP (Deployments give random pods no stable DNS).
	u := TargetURL("10.42.0.49", 8080)
	want := "http://10.42.0.49:8080"
	if u.String() != want {
		t.Errorf("TargetURL = %q, want %q", u.String(), want)
	}
}

func TestFallbackURL(t *testing.T) {
	// Non-scoped / unassigned / stale-IP → the agent-host ClusterIP Service (any ready pod).
	u := FallbackURL("agent-host", "agent-sandbox", 8080)
	want := "http://agent-host.agent-sandbox.svc.cluster.local:8080"
	if u.String() != want {
		t.Errorf("FallbackURL = %q, want %q", u.String(), want)
	}
}
